import { expect, test } from '@playwright/test';

import { decisionsOpenCount, parseDecisionsStore } from '../src/lib/decisions-parse';
import { buildReaderSources, READER_IDS, readerSource, settleReader, type ReaderOutcome } from '../src/lib/reader-sources';

/**
 * Pure checks of the source rows of the readers (card agentic-os-readers, reader 6).
 * One row per reader: {id, label, status ok|degraded|error, detail "read HH:MM, age N min" or the reason}.
 * The row shape is the app's DataSource (mission-control.ts:57-60): detail holds no path, session id or file content.
 * Pure Node. Each test names the source change that breaks it.
 */

const MIN = 60_000;
const NOW = Date.parse('2026-11-25T13:00:00.000Z');
const ok = (patch: Record<string, unknown> = {}): ReaderOutcome => ({ ok: true, readAtMs: NOW - 2 * MIN, ...patch }) as ReaderOutcome;

test.describe('buildReaderSources', () => {
  test('R1 every reader adds exactly one row, in a fixed order, with a stable id and a label', () => {
    // Breaks when a reader has no row, two rows, or an id changes.
    expect(READER_IDS).toEqual(['stalls', 'open-question', 'decisions', 'clock', 'tasks']);
    const rows = buildReaderSources(Object.fromEntries(READER_IDS.map((id) => [id, ok()])) as Record<(typeof READER_IDS)[number], ReaderOutcome>, NOW);
    expect(rows.map((r) => r.id)).toEqual([...READER_IDS]);
    for (const r of rows) {
      expect(r.label.length, r.id).toBeGreaterThan(3);
      expect(r.status, r.id).toBe('ok');
    }
  });
});

test.describe('readerSource', () => {
  test('R6 an ok row says when it was read and how old the data is', () => {
    const row = readerSource('clock', ok({ dataAtMs: NOW - 3 * MIN }), NOW);
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/^read \d\d:\d\d, age 3 min$/);
    expect(row.readAtMs).toBe(NOW - 2 * MIN);
    expect(row.ageSec).toBe(180);
  });

  test('R3 data older than the limit is degraded, and the limit is per row', () => {
    // Breaks when the threshold is dropped or one global limit replaces the per-row maxAgeMs.
    expect(readerSource('stalls', ok({ dataAtMs: NOW - 61 * MIN, maxAgeMs: 60 * MIN }), NOW).status).toBe('degraded');
    expect(readerSource('stalls', ok({ dataAtMs: NOW - 59 * MIN, maxAgeMs: 60 * MIN }), NOW).status).toBe('ok');
    expect(readerSource('tasks', ok({ dataAtMs: NOW - 61 * MIN, maxAgeMs: 24 * 60 * MIN }), NOW).status).toBe('ok');
  });

  test('R7 a missing file is degraded; any other failure is error; both name the reason, not a zero', () => {
    const missing = readerSource('decisions', { ok: false, reason: 'missing', readAtMs: NOW }, NOW);
    expect(missing.status).toBe('degraded');
    expect(missing.detail).toMatch(/missing/);
    const bad = readerSource('decisions', { ok: false, reason: 'unreadable', readAtMs: NOW }, NOW);
    expect(bad.status).toBe('error');
    expect(bad.detail).toMatch(/unreadable/);
  });

  test('R4 no detail holds a path, a session id or file content', () => {
    // Breaks when a raw reason or an error message goes into the row without safeMessage.
    const rows = [
      readerSource('tasks', { ok: false, reason: 'ENOENT: no such file C:\\Users\\someone\\repo\\tasks.json', readAtMs: NOW }, NOW),
      readerSource('decisions', { ok: false, reason: 'bad json near 0f5ea433-47f0-466d-aaab-5a7406258ff3', readAtMs: NOW }, NOW),
    ];
    for (const r of rows) {
      expect(r.detail).not.toContain('someone');
      expect(r.detail).not.toContain('C:\\');
      expect(r.detail).not.toContain('0f5ea433-47f0-466d-aaab-5a7406258ff3');
    }
  });
});

test.describe('settleReader', () => {
  test('R2 a throwing reader gives an error with a safe message and the other readers still return data', async () => {
    // Breaks when one reader's throw rejects the whole snapshot (the settle isolation of mission-control.ts:207-214).
    const [bad, good] = await Promise.all([
      settleReader(() => { throw new Error('boom at C:\\Users\\someone\\x.ts'); }),
      settleReader(async () => 42),
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).not.toContain('someone');
      expect(bad.error.length).toBeGreaterThan(0);
    }
    expect(good).toEqual({ ok: true, value: 42 });
  });
});

test.describe('the corrupt decisions case, end to end', () => {
  test('R5 a corrupt decisions.json gives an error row and a null open count, never the zero state', () => {
    // Breaks when any step folds the parse error to 0 or to an ok row: the bug the card exists to prevent.
    const view = parseDecisionsStore('{"version":1,"offers":{');
    expect(decisionsOpenCount(view)).toBeNull();
    const row = readerSource('decisions', view.ok ? ok() : { ok: false, reason: view.reason, readAtMs: NOW }, NOW);
    expect(row.status).toBe('error');
    expect(row.detail).toMatch(/unreadable/);
  });
});
