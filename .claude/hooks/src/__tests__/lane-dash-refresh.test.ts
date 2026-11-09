/**
 * shared/lane-dash-refresh: the hook-side twin of the refresh.json doc that export-dash-data.mjs writes.
 *
 * Failure list, one test (or group) each:
 *   D1  the twin parser drifts from buildRefreshDoc / clearRefreshPending (the export changes a field name)
 *   D2  the 36 h constant drifts from lane-dash.config.json stale_after_hours
 *   D3  a doc with wrong types (pending "true", exported_at a number) is read as stale
 *   D4  the age rule is off by one (exactly 36 h is stale, or an unparseable time is stale)
 *   D5  the throttle rule is wrong at the edges (exactly 1 h, a shown_at in the future, a missing key)
 *   D6  the state dir ignores LANE_DASH_STATE_DIR (a test would touch the real ~/.claude)
 *   D7  the export renames a field (key, pending, exported_at) and the twin keeps passing because of a fallback
 */
import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

import * as dash from '../shared/lane-dash-refresh.js';

// The .mjs sits outside tsc's rootDir, so load it by URL at run time.
const exportUrl = pathToFileURL(path.resolve(__dirname, '../../../../scripts/coordination/export-dash-data.mjs')).href;
const exporter: {
  buildRefreshDoc: (at: string, files: string[]) => Record<string, unknown>;
  clearRefreshPending: (doc: unknown, key: string, at: string) => Record<string, unknown>;
} = await import(/* @vite-ignore */ exportUrl);

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-08T22:00:00.000Z');
const doc = (over: Record<string, unknown> = {}) => JSON.stringify({ pending: false, key: 'k', exported_at: new Date(NOW - HOUR).toISOString(), ...over });

describe('drift against the export', () => {
  it('D1: parses what buildRefreshDoc writes, as pending with its key', () => {
    const at = '2026-11-08T20:53:03.233Z';
    const r = dash.parseRefresh(JSON.stringify(exporter.buildRefreshDoc(at, ['lanes.json'])));
    expect(r).toMatchObject({ pending: true, key: at, exportedAt: at });
  });

  it('D1: parses what clearRefreshPending writes, as not pending with the same key', () => {
    const at = '2026-11-08T20:53:03.233Z';
    const cleared = exporter.clearRefreshPending(exporter.buildRefreshDoc(at, ['lanes.json']), at, '2026-11-08T21:10:46.305Z');
    expect(dash.parseRefresh(JSON.stringify(cleared))).toMatchObject({ pending: false, key: at, exportedAt: at });
  });

  it('D2: the stale limit equals stale_after_hours in lane-dash.config.json', () => {
    const cfg = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../scripts/coordination/lane-dash.config.json'), 'utf8'));
    expect(dash.STALE_AFTER_HOURS).toBe(cfg.stale_after_hours);
  });

  it('D7: buildRefreshDoc still writes the fields the twin reads: pending, key, exported_at', () => {
    const keys = Object.keys(exporter.buildRefreshDoc('2026-11-08T20:53:03.233Z', []));
    for (const k of ['pending', 'key', 'exported_at']) expect(keys).toContain(k);
  });

  it('D1: the marker file name and refresh file name are the documented ones', () => {
    expect(dash.REFRESH_FILE).toBe('refresh.json');
    expect(dash.MARKER_FILE).toBe('.refresh-shown.json');
  });
});

describe('parseRefresh', () => {
  it('D3: null for empty, corrupt, non-object text', () => {
    for (const t of ['', '  ', '{x', '[]', 'null', '7', '"s"']) expect(dash.parseRefresh(t)).toBeNull();
  });

  it('D3: only the boolean true is pending', () => {
    expect(dash.parseRefresh(doc({ pending: 'true' }))?.pending).toBe(false);
    expect(dash.parseRefresh(doc({ pending: 1 }))?.pending).toBe(false);
    expect(dash.parseRefresh(doc({ pending: true }))?.pending).toBe(true);
  });

  it('D3: a non-string or unparseable exported_at is null', () => {
    expect(dash.parseRefresh(doc({ exported_at: 5 }))?.exportedAt).toBeNull();
    expect(dash.parseRefresh(doc({ exported_at: 'not a date' }))?.exportedAt).toBeNull();
  });

  it('D7: a doc with no key string has the empty key; there is no fallback to exported_at', () => {
    const r = dash.parseRefresh(JSON.stringify({ pending: true, exported_at: '2026-11-08T20:00:00.000Z' }));
    expect(r?.key).toBe('');
    expect(dash.parseRefresh(doc({ key: 7 }))?.key).toBe('');
  });
});

describe('staleKind', () => {
  const parse = (over: Record<string, unknown>) => dash.parseRefresh(doc(over)) as NonNullable<ReturnType<typeof dash.parseRefresh>>;

  it('D4: pending wins, even with a fresh time or no time', () => {
    expect(dash.staleKind(parse({ pending: true }), NOW)).toBe('pending');
    expect(dash.staleKind(parse({ pending: true, exported_at: null }), NOW)).toBe('pending');
  });

  it('D4: pending and also over 36 h is pending', () => {
    expect(dash.staleKind(parse({ pending: true, exported_at: new Date(NOW - 40 * HOUR).toISOString() }), NOW)).toBe('pending');
  });

  it('D4: over 36 h is age; exactly 36 h and under are not stale', () => {
    expect(dash.staleKind(parse({ exported_at: new Date(NOW - 36 * HOUR - 1).toISOString() }), NOW)).toBe('age');
    expect(dash.staleKind(parse({ exported_at: new Date(NOW - 36 * HOUR).toISOString() }), NOW)).toBeNull();
    expect(dash.staleKind(parse({ exported_at: new Date(NOW - 1 * HOUR).toISOString() }), NOW)).toBeNull();
  });

  it('D4: no usable time and not pending is silent; an export in the future is not stale', () => {
    expect(dash.staleKind(parse({ exported_at: null }), NOW)).toBeNull();
    expect(dash.staleKind(parse({ exported_at: new Date(NOW + 5 * HOUR).toISOString() }), NOW)).toBeNull();
  });
});

describe('staleLine', () => {
  it('D3: pending with no time still gives a line, without a time', () => {
    const r = dash.parseRefresh(doc({ pending: true, exported_at: null })) as NonNullable<ReturnType<typeof dash.parseRefresh>>;
    expect(dash.staleLine(r, NOW)).toBe('FleetOps data is stale (not uploaded). Tell Dave in one line. Run the fleetops-refresh skill only if he asks.');
  });

  it('D4: the exact pending and age lines', () => {
    const at = '2026-11-08T20:53:03.233Z';
    const p = dash.parseRefresh(doc({ pending: true, key: at, exported_at: at })) as NonNullable<ReturnType<typeof dash.parseRefresh>>;
    expect(dash.staleLine(p, NOW)).toBe('FleetOps data is stale (exported Nov 8, 2:53 PM CST, not uploaded). Tell Dave in one line. Run the fleetops-refresh skill only if he asks.');
    const old = '2026-11-06T20:53:03.233Z';
    const a = dash.parseRefresh(doc({ key: old, exported_at: old })) as NonNullable<ReturnType<typeof dash.parseRefresh>>;
    expect(dash.staleLine(a, NOW)).toBe('FleetOps data is stale (exported Nov 6, 2:53 PM CST, older than 36 hours). Tell Dave in one line. Run the fleetops-refresh skill only if he asks.');
  });

  it('D4: a fresh doc gives an empty string', () => {
    expect(dash.staleLine(dash.parseRefresh(doc()) as NonNullable<ReturnType<typeof dash.parseRefresh>>, NOW)).toBe('');
  });
});

describe('shouldShow', () => {
  const m = (shownAt: number, key = 'k') => ({ key, shown_at: new Date(shownAt).toISOString() });

  it('D5: no marker, or a marker of the wrong shape, shows', () => {
    expect(dash.shouldShow(null, 'k', NOW)).toBe(true);
    expect(dash.shouldShow({ key: 'k' } as never, 'k', NOW)).toBe(true);
    expect(dash.shouldShow({ key: 'k', shown_at: 'garbage' }, 'k', NOW)).toBe(true);
  });

  it('D5: same key inside or at exactly one hour is silent; over one hour shows', () => {
    expect(dash.shouldShow(m(NOW - 10 * 60_000), 'k', NOW)).toBe(false);
    expect(dash.shouldShow(m(NOW - HOUR), 'k', NOW)).toBe(false);
    expect(dash.shouldShow(m(NOW - HOUR - 1), 'k', NOW)).toBe(true);
  });

  it('D5: a different key shows at once', () => {
    expect(dash.shouldShow(m(NOW - 1000, 'old'), 'new', NOW)).toBe(true);
  });

  it('D5: a shown_at in the future (clock jump) shows rather than hiding for hours', () => {
    expect(dash.shouldShow(m(NOW + 5 * HOUR), 'k', NOW)).toBe(true);
  });
});

describe('formatChicago and laneDashDir', () => {
  it('D6: LANE_DASH_STATE_DIR wins; the default is under HOME', () => {
    expect(dash.laneDashDir({ LANE_DASH_STATE_DIR: '/x/y' })).toBe('/x/y');
    expect(dash.laneDashDir({ HOME: '/h' }).replace(/\\/g, '/')).toBe('/h/.claude/state/lane-dash');
    expect(dash.laneDashDir({ USERPROFILE: 'C:/u' }).replace(/\\/g, '/')).toBe('C:/u/.claude/state/lane-dash');
  });

  it('formatChicago: CST in winter, CDT in summer, a 12-hour clock with no padding', () => {
    expect(dash.formatChicago('2026-01-05T09:05:00.000Z')).toBe('Jan 5, 3:05 AM CST');
    expect(dash.formatChicago('2026-07-05T21:05:00.000Z')).toBe('Jul 5, 4:05 PM CDT');
  });
});
