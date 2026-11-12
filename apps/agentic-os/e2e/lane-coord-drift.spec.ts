import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import * as coord from '../src/server/queries/lane-coord';
import { laneOrderSql } from '../src/server/queries/lane-sort';

/**
 * Drift check for the lane rules that src/server/queries/lane-coord.ts copies from scripts/coordination.
 * Pure Node: no server, no database, no browser (playwright.pure.config.ts runs it, and so does CI).
 *
 * lane.mjs runs its CLI at import and exits, so it is read as TEXT. lane-dep.mjs has no side effect and is
 * imported by file URL. Ways the app copy can drift, one test each (the change that breaks it is in the name):
 *   D1  an app lane-dep builder differs from lane-dep.mjs (drop the project_key match of an open edge)
 *   D2  the unread copy differs from UNREAD_SQL in lane.mjs (read the board cursor, drop the @board rows)
 *   D3  the reclaimable copy differs from reclaimableSql, or the Ready query / card tag stops using the copy
 *   D4  the park rule differs from lane.mjs (Math.floor instead of Math.round, >= instead of >)
 *   D5  REMINDER_DUE_PRED differs (add 'acked', drop 'failed')
 *   D6  waitsOnCol adds a filter the CLI board does not have (ruling R1)
 *   D7  laneCoordFields: a park at 91m15s, a reclaimable tag without an owner
 *   D7c laneCoordFields: the due text of a done lane or an acked reminder (ruling R11)
 *   D8  toReadyCoord: a full session id in the output, a park outside the window, no per-kind limit
 *   D8e toReadyCoord: the order goes back to reminders first, so 4 or more reminders hide every unread and park row (ruling R10)
 *   D9  the time text differs from fmtCT of reminder-core.mjs
 *   D10 a component imports the VALUE side of lane-coord.ts (the SQL text would reach the browser, ruling R2)
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
/** Every .ts and .tsx file under a folder. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
const LANE = read(join(REPO, 'scripts/coordination/lane.mjs'));

/** The body of the first template literal assigned to `const <name> = ...` in lane.mjs. */
function templateOf(name: string): string {
  const match = new RegExp(`const ${name} = [^\`]*\`([\\s\\S]*?)\`;`).exec(LANE);
  expect(match, `lane.mjs must hold "const ${name} = <template>;"`).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

const NO_BOUND_PARAM = /\$\d/;

test.describe('lane-dep.mjs against the app copy', () => {
  test('D1 each builder equals the .mjs builder for l, lane and x; both refuse the same aliases', async () => {
    const mjs = await import(pathToFileURL(join(REPO, 'scripts/coordination/lane-dep.mjs')).href);
    const builders = coord as unknown as Record<string, (a: string) => string>;
    const names = ['landedShaSql', 'laneMetSql', 'lifecycleWhere', 'openDepSql', 'waitsOnSql'];
    expect(Object.keys(mjs).sort()).toEqual(names);
    for (const name of names) {
      for (const alias of ['l', 'lane', 'x']) {
        expect(builders[name](alias), `${name}('${alias}')`).toBe(mjs[name](alias));
      }
      for (const bad of ['ld_x', 'L', 'l; DROP TABLE x', '']) {
        let want = '';
        try { mjs[name](bad); } catch (error) { want = (error as Error).message; }
        expect(want, `the .mjs must refuse ${JSON.stringify(bad)}`).not.toBe('');
        expect(() => builders[name](bad)).toThrow(want);
      }
    }
  });
});

test.describe('unread direct messages', () => {
  test('D2 UNREAD_SQL starts with the self-exclusion and holds the DM branch; the app copy is the same text with c.id', () => {
    const unread = templateOf('UNREAD_SQL');
    expect(unread.startsWith(`${coord.UNREAD_SELF_SOURCE} AND (`)).toBe(true);
    expect(unread).toContain(coord.DM_UNREAD_SOURCE);
    // The cursor is the MAX over <uuid> and <uuid>@...: both halves are in the copy.
    expect(coord.DM_UNREAD_SOURCE).toContain('SELECT MAX(last_event_id)');
    expect(coord.DM_UNREAD_SOURCE).toContain("starts_with(session_id, $1::text || '@')");
    expect(coord.DM_UNREAD_SOURCE).not.toContain('$3');
    const rendered = coord.unreadDmSql('c.id');
    expect(rendered).toBe(`${coord.UNREAD_SELF_SOURCE} AND ${coord.DM_UNREAD_SOURCE}`.split('$1::text').join('c.id'));
    expect(rendered).not.toMatch(NO_BOUND_PARAM);
    expect(rendered.startsWith('e.session_id <> c.id AND (e.to_session_id = c.id')).toBe(true);
    expect(() => coord.unreadDmSql('c.id; DROP TABLE x')).toThrow(/bad column/);
  });
});

test.describe('reclaimable', () => {
  test('D3 STALE_MINUTES, ALIVE_AT and reclaimableSql equal lane.mjs; the Ready query and the tag use them', () => {
    const stale = /const STALE_MINUTES = (\d+);/.exec(LANE);
    expect(stale).not.toBeNull();
    expect(coord.STALE_MINUTES).toBe(Number((stale as RegExpExecArray)[1]));

    const alive = templateOf('ALIVE_AT').split('${alias}').join('s.');
    expect(alive).not.toContain('${');
    expect(coord.ALIVE_AT('s.')).toBe(alive);

    const rendered = templateOf('reclaimableSql')
      .split('${alias}').join('l')
      .split("${ALIVE_AT('s.')}").join(alive)
      .split('${STALE_MINUTES}').join(String(coord.STALE_MINUTES));
    expect(rendered, 'every ${...} of the template is rendered').not.toContain('${');
    expect(coord.reclaimableSql('l')).toBe(rendered);

    // The card tag is an owner AND the CLI rule: without the owner every backlog lane would carry it.
    expect(coord.RECLAIMABLE_TAG_SQL).toBe(`(l.owner_session_id IS NOT NULL AND ${coord.reclaimableSql('l')})`);

    // The Ready query is built from the checked pieces, not from its own drifted text.
    const ready = coord.readyCoordSql();
    expect(ready).toContain(coord.unreadDmSql('c.id'));
    expect(ready).toContain(coord.REMINDER_DUE_WHERE);
    expect(ready).toContain(coord.ALIVE_AT('s.'));
    // The idle test of the Ready query uses the checked ALIVE_AT and STALE_MINUTES, not text of its own.
    expect(ready).toContain(`AND ${coord.ALIVE_AT('s.')} <= (now() AT TIME ZONE 'UTC') - interval '${coord.STALE_MINUTES} minutes'`);
    expect(ready).toContain(laneOrderSql('l'));
    // The park branch pre-filter: a SQL cut above 91 minutes (the exact rule is isParked) and the 48 hour window. A looser or
    // tighter cut drops lanes the CLI calls parked, and no seed can hold a lease at 91m31s for a whole run, so the text is pinned.
    expect(ready).toContain(`l.lease_expires_at > now() + interval '${coord.LEASE_MINUTES + 1} minutes'`);
    expect(ready).toContain(`l.lease_expires_at <= now() + interval '${coord.PARK_WINDOW_SECONDS} seconds'`);
    expect(coord.PARK_WINDOW_SECONDS).toBe(48 * 60 * 60);
    // The idle window of the unread branch: 24 hours, as the build brief says. The literal is pinned too: the constant can change.
    expect(ready).toContain(`interval '${coord.IDLE_WINDOW_HOURS} hours'`);
    expect(coord.IDLE_WINDOW_HOURS).toBe(24);
    expect(ready).toContain("interval '24 hours'");
    // The index-exact session filter (sessions_last_signal_idx) and the never-selected columns.
    expect(ready).toContain("GREATEST(s.last_heartbeat, s.last_activity_at, s.ended_at)");
    expect(ready).toContain("s.id NOT LIKE 's-%'");
    expect(ready).not.toMatch(/\b[a-z]+\.(body|detail)\b/);

    // A drizzle sql.raw text with a $n would bind silently to a drizzle parameter.
    for (const text of [ready, coord.RECLAIMABLE_TAG_SQL, coord.waitsOnCol(true), coord.waitsOnCol(false)]) {
      expect(text).not.toMatch(NO_BOUND_PARAM);
    }
  });
});

test.describe('parked', () => {
  test('D4 lane.mjs keeps the rule; isParked gives false at 91m29s, true at 91m31s and 92m, false with no lease or owner', () => {
    expect(LANE).toContain('const LEASE_MINUTES = 90;');
    expect(LANE).toContain('const parked = lease > LEASE_MINUTES + 1;');
    expect(LANE).toContain('Math.round((new Date(l.lease_expires_at) - Date.now()) / 60000)');
    expect(coord.LEASE_MINUTES).toBe(90);
    const now = 1_800_000_000;
    expect(coord.isParked(true, now + 91 * 60 + 29, now)).toBe(false);
    expect(coord.isParked(true, now + 91 * 60 + 31, now)).toBe(true);
    expect(coord.isParked(true, now + 92 * 60, now)).toBe(true);
    expect(coord.isParked(true, now + 91 * 60, now)).toBe(false);
    expect(coord.isParked(true, null, now)).toBe(false);
    expect(coord.isParked(false, now + 3 * 3600, now)).toBe(false);
    expect(coord.leaseMinutes(null, now)).toBeNull();
    expect(coord.leaseMinutes(now + 91 * 60 + 31, now)).toBe(92);
  });
});

test.describe('reminder due', () => {
  test('D5 REMINDER_DUE_PRED equals lane.mjs; the list rule adds the done filter', () => {
    expect(coord.REMINDER_DUE_PRED).toBe(templateOf('REMINDER_DUE_PRED'));
    expect(coord.REMINDER_DUE_PRED).not.toContain("'acked'");
    expect(LANE).toContain("`l.state <> 'done' AND ${REMINDER_DUE_PRED}`");
    expect(coord.REMINDER_DUE_WHERE).toBe(`l.state <> 'done' AND ${coord.REMINDER_DUE_PRED}`);
  });
});

test.describe('waits on', () => {
  test('D6 the board column is the lane-dep builder as it is: no state filter (R1); no table, no column', () => {
    expect(coord.waitsOnCol(true)).toBe(coord.waitsOnSql('l'));
    expect(coord.waitsOnCol(true)).not.toContain("state <> 'done'");
    expect(coord.waitsOnCol(false)).toBe("'{}'::text[]");
  });
});

// --- The pure mappers --------------------------------------------------------------------------

const NOW = 1_800_000_000;
const UUID = '0d40499c-1111-4222-8333-444455556666';
const base = (over: Partial<coord.LaneCoordRaw> = {}): coord.LaneCoordRaw => ({
  owner_session_id: UUID, band: null, due_epoch: null, lease_epoch: null, now_epoch: NOW,
  reclaimable: false, waits_on: [], ...over,
});

test.describe('laneCoordFields', () => {
  test('D7 a park needs an owner and more than 91m30s; reclaimable needs an owner; a bad band is dropped', () => {
    expect(coord.laneCoordFields(base({ lease_epoch: NOW + 91 * 60 + 15 })).parkedUntil, '91m15s is not parked').toBeNull();
    expect(coord.laneCoordFields(base({ lease_epoch: NOW + 91 * 60 + 45 })).parkedUntil).toMatch(/^[A-Z][a-z]{2} \d\d-\d\d \d\d:\d\d C[SD]T$/);
    expect(coord.laneCoordFields(base({ lease_epoch: NOW + 3 * 3600, owner_session_id: null })).parkedUntil).toBeNull();
    expect(coord.laneCoordFields(base({ lease_epoch: String(NOW + 3 * 3600), now_epoch: String(NOW) })).parkedUntil, 'numeric strings').not.toBeNull();
    expect(coord.laneCoordFields(base({ reclaimable: true, owner_session_id: null })).reclaimable).toBe(false);
    expect(coord.laneCoordFields(base({ reclaimable: true })).reclaimable).toBe(true);
    expect(coord.laneCoordFields(base({ reclaimable: null })).reclaimable).toBe(false);
    expect(coord.laneCoordFields(base({ band: 'P1' })).band).toBe('P1');
    expect(coord.laneCoordFields(base({ band: 'P9' })).band).toBeNull();
    expect(coord.laneCoordFields(base()).due).toBeNull();
    expect(coord.laneCoordFields(base({ due_epoch: NOW })).due).toMatch(/ C[SD]T$/);
  });

  test('D7c R11 the due text shows unless the lane is done or its reminder is acked; a future due time and every other state still show', () => {
    const due = { due_epoch: NOW + 3600 };
    expect(coord.laneCoordFields(base({ ...due, state: 'backlog', remind_state: 'scheduled' })).due, 'a future due time shows').toMatch(/ C[SD]T$/);
    expect(coord.laneCoordFields(base({ ...due, state: 'backlog', remind_state: 'acked' })).due, 'acked').toBeNull();
    expect(coord.laneCoordFields(base({ ...due, state: 'done', remind_state: 'scheduled' })).due, 'a done lane').toBeNull();
    expect(coord.laneCoordFields(base({ ...due, state: 'done', remind_state: 'acked' })).due).toBeNull();
    for (const remind of ['due', 'needs_dave', 'failed', null]) {
      expect(coord.laneCoordFields(base({ ...due, state: 'active', remind_state: remind })).due, `remind_state ${String(remind)}`).toMatch(/ C[SD]T$/);
    }
    expect(coord.laneCoordFields(base({ ...due })).due, 'no state or remind_state in the row: the time shows').toMatch(/ C[SD]T$/);
  });

  test('D7b waits-on shows ten ids, counts the rest, and clips and cleans each id', () => {
    const ids = Array.from({ length: 13 }, (_, i) => `dep-${i}`);
    const fields = coord.laneCoordFields(base({ waits_on: ids }));
    expect(fields.waitsOn).toEqual(ids.slice(0, 10));
    expect(fields.waitsOnMore).toBe(3);
    expect(coord.laneCoordFields(base({ waits_on: 'not an array' })).waitsOn).toEqual([]);
    expect(coord.laneCoordFields(base({ waits_on: ['x'.repeat(200)] })).waitsOn[0].length).toBeLessThanOrEqual(60);
  });
});

const raw = (over: Partial<coord.CoordRaw>): coord.CoordRaw => ({
  kind: 'reminder', sid: null, lane_id: null, title: null, project_key: null, band: null,
  n: null, idle_seconds: null, at_epoch: null, now_epoch: NOW, ...over,
});
const lane = (kind: 'park' | 'reminder', i: number, at: number): coord.CoordRaw =>
  raw({ kind, lane_id: `lane-${i}`, title: `Title ${i}`, project_key: 'continuous-claude', at_epoch: at });

test.describe('toReadyCoord', () => {
  test('D8 the full session id never leaves; the row text follows the wording rule R8', () => {
    const names = new Map([[UUID, 'trex']]);
    const out = coord.toReadyCoord([
      raw({ kind: 'unread', sid: UUID, n: 3, idle_seconds: 32 * 60 + 20 }),
      raw({ kind: 'unread', sid: 'abcdef12-1111-4222-8333-444455556666', n: 1, idle_seconds: 6 * 60 }),
    ], names);
    const json = JSON.stringify(out);
    expect(json).not.toContain(UUID);
    expect(json).not.toContain('abcdef12-1111');
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(out.status).toBe('ok');
    expect(out.rows.map((r) => r.text)).toEqual([
      'trex #0d40499c: 3 unread direct messages, idle 32 min',
      'unnamed #abcdef12: 1 unread direct message, idle 6 min',
    ]);
    expect(coord.toReadyCoord([raw({ kind: 'unread', sid: UUID, n: 0, idle_seconds: 600 })], names).rows).toEqual([]);
  });

  test('D8b a park shows only inside (91m30s, 48 h]; park and reminder rows carry the lane, the board and the time text', () => {
    const rows = coord.toReadyCoord([
      lane('park', 1, NOW + 91 * 60 + 29),
      lane('park', 2, NOW + 91 * 60 + 31),
      lane('park', 3, NOW + 48 * 3600),
      lane('park', 4, NOW + 48 * 3600 + 1),
      lane('reminder', 5, NOW - 600),
    ], new Map()).rows;
    // R10: one row of each kind first (park, reminder), then the rest (the second park).
    expect(rows.map((r) => (r.kind === 'unread' ? '' : r.laneId))).toEqual(['lane-2', 'lane-5', 'lane-3']);
    expect(rows[1].text).toMatch(/^lane-5 reminder due [A-Z][a-z]{2} \d\d-\d\d \d\d:\d\d C[SD]T \(continuous-claude\)$/);
    expect(rows[0].text).toMatch(/^lane-2 parked until [A-Z][a-z]{2} \d\d-\d\d \d\d:\d\d C[SD]T \(continuous-claude\)$/);
  });

  test('D8c at most 20 rows per kind; truncated says more exist; one row of each kind comes first (unread, park, reminder)', () => {
    const many = Array.from({ length: 21 }, (_, i) => lane('reminder', i, NOW - 60));
    const out = coord.toReadyCoord(many, new Map());
    expect(out.rows).toHaveLength(20);
    expect(out.truncated).toBe(true);
    const mixed = coord.toReadyCoord([
      lane('park', 1, NOW + 3 * 3600),
      raw({ kind: 'unread', sid: UUID, n: 1, idle_seconds: 600 }),
      lane('reminder', 2, NOW - 60),
    ], new Map());
    expect(mixed.rows.map((r) => r.kind)).toEqual(['unread', 'park', 'reminder']);
    expect(mixed.truncated).toBe(false);
    expect(mixed.nowEpoch).toBe(NOW);
    expect(coord.toReadyCoord([], new Map())).toMatchObject({ status: 'ok', rows: [], nowEpoch: null });
    expect(coord.coordError('boom')).toMatchObject({ status: 'error', error: 'boom', rows: [] });
  });

  test('D8f the exact park rule runs before the per-kind limit: 20 leases under the rule do not push out a real park', () => {
    // The SQL pre-filter is loose (91 minutes). These 20 rows pass it and fail isParked (91m15s rounds to 91).
    const under = Array.from({ length: 20 }, (_, i) => lane('park', i, NOW + 91 * 60 + 15));
    const out = coord.toReadyCoord([...under, lane('park', 99, NOW + 3 * 3600)], new Map());
    expect(out.rows.map((r) => (r.kind === 'park' ? r.laneId : r.kind))).toEqual(['lane-99']);
  });

  test('D8e R10: with 5 reminders, 2 unread and 1 park the first four rows are unread, park, reminder, unread; no kind is hidden by another', () => {
    const names = new Map<string, string>();
    const out = coord.toReadyCoord([
      ...Array.from({ length: 5 }, (_, i) => lane('reminder', i, NOW - 60)),
      raw({ kind: 'unread', sid: UUID, n: 1, idle_seconds: 600 }),
      raw({ kind: 'unread', sid: 'abcdef12-1111-4222-8333-444455556666', n: 2, idle_seconds: 900 }),
      lane('park', 9, NOW + 3 * 3600),
    ], names);
    expect(out.rows.map((r) => r.kind)).toEqual(['unread', 'park', 'reminder', 'unread', 'reminder', 'reminder', 'reminder', 'reminder']);
    // Inside a kind the order is the order the SQL gave.
    const unread = out.rows.filter((r) => r.kind === 'unread').map((r) => r.text);
    expect(unread[0]).toContain('#0d40499c');
    expect(unread[1]).toContain('#abcdef12');
    const reminders = out.rows.filter((r) => r.kind === 'reminder').map((r) => (r.kind === 'reminder' ? r.laneId : ''));
    expect(reminders).toEqual(['lane-0', 'lane-1', 'lane-2', 'lane-3', 'lane-4']);
    // A kind with no rows leaves no gap: two kinds only.
    const two = coord.toReadyCoord([lane('reminder', 1, NOW - 60), lane('reminder', 2, NOW - 60), lane('park', 3, NOW + 3 * 3600)], names);
    expect(two.rows.map((r) => r.kind)).toEqual(['park', 'reminder', 'reminder']);
  });

  test('D8d titles are cleaned: a path, a secret, a url and a full session id never reach the row', () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz123456';
    const titleOf = (title: string): string => {
      const row = coord.toReadyCoord([
        raw({ kind: 'reminder', lane_id: 'r1', title, project_key: 'continuous-claude', at_epoch: NOW - 60 }),
      ], new Map()).rows[0];
      return row.kind === 'reminder' ? row.title : '';
    };
    expect(titleOf('see C:\\Users\\dave\\notes.txt now')).not.toContain('dave');
    expect(titleOf(`rotate API_KEY=${secret} today`), 'the redact() call masks a credential').not.toContain(secret);
    const url = titleOf('open https://user:hunter2pass@example.com/x?y=1 and https://example.com/z now');
    expect(url).not.toContain('hunter2pass');
    expect(url).not.toContain('://');
    expect(url).toMatch(/^open .* and .* now$/);
    const id = titleOf(`session ${UUID} ended`);
    expect(id).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(id).toMatch(/^session .* ended$/);
    // Lane ids and waits-on ids go through the same cleaner.
    expect(coord.cleanText('plain-lane-id', 60)).toBe('plain-lane-id');
  });
});

test.describe('time text', () => {
  test('D9 formatCtWhen equals fmtCT of reminder-core.mjs, also across the two clock changes of 2026', async () => {
    const core = await import(pathToFileURL(join(REPO, 'scripts/coordination/reminder-core.mjs')).href);
    expect(typeof core.fmtCT, 'reminder-core.mjs must export fmtCT').toBe('function');
    const epochs = [
      Date.UTC(2026, 10, 19, 0, 58), Date.UTC(2026, 10, 16, 15, 0), Date.UTC(2026, 6, 1, 17, 0), Date.UTC(2026, 10, 12, 6, 5),
      Date.UTC(2026, 10, 1, 6, 59), Date.UTC(2026, 10, 1, 7, 0), // CDT to CST
      Date.UTC(2026, 2, 8, 7, 59), Date.UTC(2026, 2, 8, 8, 0), // CST to CDT
    ].map((ms) => ms / 1000);
    for (const e of epochs) expect(coord.formatCtWhen(e), `epoch ${e}`).toBe(core.fmtCT(new Date(e * 1000)));
  });

  test('D9b formatCtWhen prints the CLI format: weekday, month-day, 24 h time, short zone', () => {
    expect(coord.formatCtWhen(Date.UTC(2026, 10, 19, 0, 58) / 1000)).toBe('Wed 11-18 18:58 CST');
    expect(coord.formatCtWhen(Date.UTC(2026, 10, 16, 15, 0) / 1000)).toBe('Mon 11-16 09:00 CST');
    expect(coord.formatCtWhen(Date.UTC(2026, 6, 1, 17, 0) / 1000)).toBe('Wed 07-01 12:00 CDT');
    expect(coord.formatCtWhen(Date.UTC(2026, 10, 12, 6, 5) / 1000), 'midnight hour is 00, not 24').toBe('Thu 11-12 00:05 CST');
  });
});

test.describe('the browser bundle', () => {
  test('D10 no client file imports a value from lane-coord or mission-control; lane-coord.ts imports nothing outside its folder tree', () => {
    // Client files: every file under src/components and every file anywhere in src that starts a line with 'use client'.
    const files = sourceFiles(join(APP, 'src')).filter(
      (file) => file.replace(/\\/g, '/').includes('/src/components/') || /^['"]use client['"]/m.test(read(file)),
    );
    expect(files.length, 'the scan must find the client files').toBeGreaterThan(10);
    let typeImports = 0;
    for (const file of files) {
      const imports = read(file).match(/^import\s[^;]*?from\s+['"][^'"]*(?:lane-coord|mission-control)['"];?/gm) ?? [];
      for (const line of imports) {
        expect(line, `${file}: a client file imports a value: ${line}`).toMatch(/^import type /);
        typeImports += 1;
      }
    }
    expect(typeImports, 'control: the scan saw the type imports of the fleet components').toBeGreaterThan(5);
    const source = read(join(APP, 'src/server/queries/lane-coord.ts'));
    expect(source).not.toMatch(/^import\s+['"]server-only['"]/m);
    expect(source).not.toMatch(/from\s+['"]@\//);
    expect(source).not.toMatch(/from\s+['"]next/);
  });
});
