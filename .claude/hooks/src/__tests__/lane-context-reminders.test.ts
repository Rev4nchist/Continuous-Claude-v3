/**
 * lane-context shows due reminders at SessionStart (lane reminders, phase 3).
 *
 * Failure list, one test (or group) each:
 *   M1  no "Reminders due" block, or it sits below "Claimable next", or a row is lost
 *   M2  the reminders SQL lacks a part of the contract (due_at <= now(), remind_state, LIMIT 5, project_key, the shared order)
 *   M3  the reminders SQL contains text that the board test stub routes on, so it steals another query's rows
 *   M4  the claimable SQL still offers a lane whose due_at is in the future, or a reminder lane (track reminders) as work
 *   M5  more than 5 rows are printed, or the overflow line does not name `remind list`
 *   M6  an empty result prints a heading; UserPromptSubmit or PostToolUse run the reminders query
 *   M7  a failing reminders query drops the whole banner; a failing renew stops returning {}
 *   M8  a bad database connection prints something other than {}
 *   M9  the hint names a relative lane.mjs path; a row never says OVERDUE; an action_id gets run or hidden
 *   M10 the hook SQL and the lane.mjs SQL drift apart; dueCT and overdue give other text than fmtCT and overdueLabel
 *   M11 a row due in the future reaches the output through the formatter
 *
 * The database is a stub that records SQL. The real SQL (including the row order and the reminder exclusion) runs in
 * scripts/coordination/reminder-probe.mjs (scratch database).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] | undefined }>,
  claimable: [] as Array<Record<string, unknown>>,
  reminders: [] as Array<Record<string, unknown>>,
  failOn: null as RegExp | null,
  failCode: '42501',
  failConnect: false,
}));

vi.mock('pg', () => {
  class Client {
    on(): this { return this; }
    async connect(): Promise<void> { if (fake.failConnect) throw new Error('connect ECONNREFUSED'); }
    async end(): Promise<void> { /* closed */ }
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      fake.calls.push({ sql, params });
      if (fake.failOn && fake.failOn.test(sql)) throw Object.assign(new Error('boom: ' + sql.slice(0, 30)), { code: fake.failCode });
      // The reminders query is told apart by its remind_state predicate (the claimable query filters on track instead). Its text must not match any other route (M3).
      if (/remind_state IN/.test(sql)) return { rows: fake.reminders };
      if (/FROM sessions s/.test(sql)) return { rows: [] };
      if (/FROM agentic_os\.lane_event/.test(sql)) return { rows: [] };
      if (/state IN \('ready','backlog'\)/.test(sql)) return { rows: fake.claimable };
      return { rows: [] };
    }
  }
  return { Client, default: { Client } };
});

import { pathToFileURL } from 'node:url';
import { dueCT, formatReminderLines, overdue, runLaneContext } from '../lane-context.js';
import { laneOrderSql } from '../shared/lane-sort.js';

// The CLI twin sits outside tsc's rootDir, so load it by URL at run time (as lane-sort-twin.test.ts does).
const core: {
  REMIND_STATES: string[]; fmtCT: (d: string | Date) => string; overdueLabel: (due: string | Date, now: Date) => string;
} = await import(/* @vite-ignore */ pathToFileURL(join(__dirname, '../../../../scripts/coordination/reminder-core.mjs')).href);

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const SRC_LANE_MJS = readFileSync(join(__dirname, '../../../../scripts/coordination/lane.mjs'), 'utf8');
const SRC_HOOK = readFileSync(join(__dirname, '../lane-context.ts'), 'utf8');
const MIGRATION_0005 = readFileSync(join(__dirname, '../../../../apps/agentic-os/drizzle/0005_lane_reminders.sql'), 'utf8');

let tmp: string;
let ccv3: string;
const keys = ['LANE_REGISTRY_PATH', 'DATABASE_URL', 'CONTINUOUS_CLAUDE_DB_URL', 'CCV3_IDENTITY_DIR', 'CCV3_USER_HOME',
  'LANE_BOARD_CACHE', 'LANE_CONTEXT_ERROR_LOG', 'CLAUDE_CODE_ENTRYPOINT', 'LANE_CONTEXT_HEADLESS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of keys) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'lc-rem-'));
  ccv3 = join(tmp, 'ccv3');
  mkdirSync(ccv3, { recursive: true });
  writeFileSync(join(tmp, 'registry.json'), JSON.stringify({ projects: [{ name: 'CCv3', key: 'continuous-claude', path: ccv3, status: 'active' }] }));
  process.env.LANE_REGISTRY_PATH = join(tmp, 'registry.json');
  process.env.DATABASE_URL = 'postgres://stub@127.0.0.1:1/stub';
  delete process.env.CONTINUOUS_CLAUDE_DB_URL;
  process.env.CCV3_IDENTITY_DIR = join(tmp, 'ident');
  process.env.CCV3_USER_HOME = 'C:/Users/Tester';
  process.env.LANE_BOARD_CACHE = '0';
  process.env.LANE_CONTEXT_ERROR_LOG = join(tmp, 'errors.jsonl');
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.LANE_CONTEXT_HEADLESS;
  fake.calls.length = 0; fake.claimable = []; fake.reminders = []; fake.failOn = null; fake.failCode = '42501'; fake.failConnect = false;
});
afterEach(() => {
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(join(tmpdir(), `claude-lane-err-${ME}.json`), { force: true });
  rmSync(tmp, { recursive: true, force: true });
});

const run = async (event: string, cwd = ccv3): Promise<{ hookSpecificOutput?: { additionalContext: string } }> =>
  (await runLaneContext(JSON.stringify({ session_id: ME, hook_event_name: event, cwd }))) as never;
const text = (o: { hookSpecificOutput?: { additionalContext: string } }): string => o.hookSpecificOutput?.additionalContext ?? '';
const remQuery = () => fake.calls.find((c) => /remind_state IN/.test(c.sql));
const claimQuery = () => fake.calls.find((c) => /state IN \('ready','backlog'\)/.test(c.sql));
const past = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
const row = (id: string, band: string | null, minLate: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, title: `title of ${id}`, band, due_at: past(minLate), remind_state: 'scheduled', fired_at: null, action_id: null, total: 3, ...extra,
});

describe('M1: the block', () => {
  // Row order is the SQL's job (M2 asserts the ORDER BY text, the probe asserts the real order). The formatter keeps input order.
  it('prints "## Reminders due (3)" above "Claimable next" with every row', async () => {
    fake.claimable = [{ id: 'c-1', title: 'claim me', band: 'P1' }];
    fake.reminders = [row('zz-p0', 'P0', 30), row('zz-p1', 'P1', 20), row('zz-none', null, 10)];
    const t = text(await run('SessionStart'));
    expect(t).toContain('## Reminders due (3)');
    expect(t.indexOf('## Reminders due (3)')).toBeLessThan(t.indexOf('Claimable next'));
    for (const id of ['zz-p0', 'zz-p1', 'zz-none']) expect(t).toContain(id);
    expect(t).toMatch(/P0 zz-p0/);
  });
});

describe('M2-M3: the reminders SQL', () => {
  it('M2: carries the contract', async () => {
    await run('SessionStart');
    const q = remQuery();
    expect(q, 'no reminders query ran').toBeDefined();
    expect(q?.sql).toContain('due_at <= now()');
    expect(q?.sql).toContain('remind_state');
    expect(q?.sql).toContain('LIMIT 5');
    expect(q?.sql).toContain('project_key = $1');
    expect(q?.sql).toContain(laneOrderSql('l'));
    expect(q?.params).toEqual(['continuous-claude']);
  });

  it('M3: contains none of the text the board stub routes on', async () => {
    await run('SessionStart');
    const sql = remQuery()?.sql ?? '';
    expect(sql).not.toContain("state IN ('ready','backlog')");
    expect(sql).not.toContain('FROM sessions s');
    expect(sql).not.toContain('FROM agentic_os.lane_event');
    expect(sql).not.toContain("WHERE owner_session_id=$1 AND state<>'done'");
  });
});

describe('M4: claimable hides a future-due lane and every reminder lane', () => {
  it('the claimable SQL carries the due filter', async () => {
    await run('SessionStart');
    expect(claimQuery()?.sql).toContain('due_at IS NULL OR l.due_at <= now()');
  });

  it('the claimable SQL excludes track reminders (an acked or due reminder is not work)', async () => {
    await run('SessionStart');
    expect(claimQuery()?.sql).toContain("l.track <> 'reminders'");
  });
});

describe('M5: the cap', () => {
  it('prints 5 rows and a +N more line that names `remind list`', async () => {
    fake.reminders = ['a', 'b', 'c', 'd', 'e'].map((x, i) => row(`zz-${x}`, 'P1', 10 + i, { total: 8 }));
    const t = text(await run('SessionStart'));
    expect(t).toContain('## Reminders due (8)');
    expect(['zz-a', 'zz-b', 'zz-c', 'zz-d', 'zz-e'].every((id) => t.includes(id))).toBe(true);
    expect(t).toMatch(/\+3 more[^\n]*remind list/);
  });

  it('exactly 5 due rows print no overflow line', async () => {
    fake.reminders = ['a', 'b', 'c', 'd', 'e'].map((x) => row(`zz-${x}`, 'P1', 10, { total: 5 }));
    expect(text(await run('SessionStart'))).not.toMatch(/more/);
  });
});

describe('M6: silence', () => {
  it('zero due rows print no heading at all', async () => {
    const t = text(await run('SessionStart'));
    expect(t).toContain('## Lane board continuous-claude');
    expect(t).not.toContain('Reminders due');
  });

  it('UserPromptSubmit and PostToolUse never run the reminders query', async () => {
    fake.reminders = [row('zz-p0', 'P0', 30)];
    expect(text(await run('UserPromptSubmit'))).not.toContain('Reminders due');
    await run('PostToolUse');
    expect(remQuery()).toBeUndefined();
  });
});

describe('M7: failure posture', () => {
  it('a failing reminders query (42703) still returns the banner without the block', async () => {
    fake.failOn = /remind_state IN/; fake.failCode = '42703';
    fake.claimable = [{ id: 'c-1', title: 'claim me', band: null }];
    const t = text(await run('SessionStart'));
    expect(t).toContain('## Lane board continuous-claude');
    expect(t).toContain('Claimable next');
    expect(t).not.toContain('Reminders due');
  });

  it('a failing renew still returns {}', async () => {
    fake.failOn = /UPDATE agentic_os\.lane\s+SET lease_expires_at/;
    expect(await run('SessionStart')).toEqual({});
    expect(remQuery()).toBeUndefined();
  });
});

describe('M8: a bad connection', () => {
  it('returns {} and does not throw', async () => {
    fake.failConnect = true;
    expect(await run('SessionStart')).toEqual({});
  });
});

describe('M9: hint text and rows', () => {
  it('names the shim path through laneCliCmd(), never a relative lane.mjs', async () => {
    fake.reminders = [row('zz-p0', 'P0', 30)];
    const t = text(await run('SessionStart'));
    expect(t).toContain('node C:/Users/Tester/.claude/scripts/lane.mjs remind ack <id>');
    expect(t).toContain('node C:/Users/Tester/.claude/scripts/lane.mjs remind snooze <id> --for 2h');
    expect(t).not.toMatch(/node scripts\/coordination\/lane\.mjs/);
  });

  it('a row more than 60 min late says OVERDUE; one 30 min late does not', () => {
    const now = new Date('2026-11-06T16:00:00Z');
    const lines = formatReminderLines([
      { id: 'late', title: 't', band: 'P1', due_at: '2026-11-06T13:55:00Z', remind_state: 'scheduled', action_id: null },
      { id: 'recent', title: 't', band: 'P1', due_at: '2026-11-06T15:30:00Z', remind_state: 'scheduled', action_id: null },
    ], now).join('\n');
    expect(lines).toMatch(/late[^\n]*OVERDUE 2h/);
    expect(lines.split('\n').find((l: string) => l.includes('recent'))).not.toContain('OVERDUE');
  });

  it('shows the due time in Chicago time with the zone in force', () => {
    const lines = formatReminderLines([
      { id: 'x', title: 't', band: 'P1', due_at: '2026-11-06T14:00:00Z', remind_state: 'scheduled', action_id: null },
    ], new Date('2026-11-06T15:00:00Z')).join('\n');
    expect(lines).toContain('Fri 11-06 08:00 CST');
  });

  it('an action_id is shown as plain text and nothing runs', async () => {
    fake.reminders = [row('zz-act', 'P1', 5, { action_id: 'doctor.run' })];
    const t = text(await run('SessionStart'));
    expect(t).toMatch(/action: doctor\.run/);
    // The only queries are reads, the renew and the client_version setting: no INSERT, no other UPDATE.
    const writes = fake.calls.filter((c) => /\b(INSERT|DELETE)\b/.test(c.sql) || (/\bUPDATE\b/.test(c.sql) && !/SET lease_expires_at/.test(c.sql)));
    expect(writes).toHaveLength(0);
  });
});

describe('M10: the hook SQL is the lane.mjs SQL', () => {
  const fragment = (src: string, name: string): string => {
    const m = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(src);
    expect(m, `${name} not found`).not.toBeNull();
    return (m as RegExpExecArray)[1].replace(/\s+/g, ' ').trim();
  };

  it('REMINDER_DUE_PRED matches verbatim', () => {
    expect(fragment(SRC_HOOK, 'REMINDER_DUE_PRED')).toBe(fragment(SRC_LANE_MJS, 'REMINDER_DUE_PRED'));
  });

  it('the hook query uses that predicate', async () => {
    await run('SessionStart');
    const folded = (remQuery()?.sql ?? '').replace(/\s+/g, ' ');
    expect(folded).toContain(fragment(SRC_HOOK, 'REMINDER_DUE_PRED'));
  });

  it('CLAIMABLE_NOT_REMINDER (the track exclusion and the due filter) matches verbatim', () => {
    const f = fragment(SRC_LANE_MJS, 'CLAIMABLE_NOT_REMINDER');
    expect(fragment(SRC_HOOK, 'CLAIMABLE_NOT_REMINDER')).toBe(f);
    expect(f).toContain("l.track <> 'reminders'");
    expect(f).toContain('l.due_at IS NULL OR l.due_at <= now()');
  });

  it('the hook claimable query uses that constant', async () => {
    await run('SessionStart');
    expect((claimQuery()?.sql ?? '').replace(/\s+/g, ' ')).toContain(fragment(SRC_HOOK, 'CLAIMABLE_NOT_REMINDER'));
  });

  it('REMIND_STATES is the migration CHECK, and the due predicate lists every state but acked', () => {
    const check = /lane_remind_state_check" CHECK \([^)]*IN \(([^)]*)\)/.exec(MIGRATION_0005)?.[1];
    expect(check, 'lane_remind_state_check not found in migration 0005').toBeDefined();
    const inMigration = (check as string).split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(core.REMIND_STATES).toEqual(inMigration);
    const pred = fragment(SRC_HOOK, 'REMINDER_DUE_PRED');
    const listed = /remind_state IN \(([^)]*)\)/.exec(pred)?.[1].split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(listed).toEqual(inMigration.filter((x) => x !== 'acked'));
  });
});

describe('M10: dueCT and overdue are fmtCT and overdueLabel', () => {
  // Fixed instants: DST start (2026-03-08 08:00Z) and end (2026-11-01 07:00Z) edges, a year boundary, a Date and a string.
  const instants = [
    '2026-03-08T07:59:00Z', '2026-03-08T08:00:00Z', '2026-07-06T13:00:00Z', '2026-11-01T05:59:00Z', '2026-11-01T06:00:00Z',
    '2026-11-01T07:00:00Z', '2026-11-06T14:00:00Z', '2026-12-31T23:59:00Z', '2027-01-01T06:00:00Z',
  ];
  it('dueCT gives the same text for every instant', () => {
    for (const t of instants) {
      expect(dueCT(t), t).toBe(core.fmtCT(t));
      expect(dueCT(new Date(t)), t).toBe(core.fmtCT(new Date(t)));
    }
  });

  it('overdue gives the same label at every lateness, including the 60 minute, 24 hour and future edges', () => {
    const due = '2026-11-06T12:00:00Z';
    const lateMin = [-30, 0, 1, 59, 60, 61, 119, 120, 121, 1439, 1440, 1441, 2879, 2880, 10_000, 60 * 24 * 30];
    for (const m of lateMin) {
      const now = new Date(new Date(due).getTime() + m * 60_000);
      expect(overdue(due, now), String(m)).toBe(core.overdueLabel(due, now));
    }
    expect(overdue(due, new Date('2026-11-06T14:00:00Z'))).toBe('OVERDUE 2h');
  });
});

describe('M11: the formatter drops a future row', () => {
  it('a row due after now never reaches the output', () => {
    const now = new Date('2026-11-06T16:00:00Z');
    const out = formatReminderLines([
      { id: 'future', title: 't', band: 'P0', due_at: '2026-11-07T16:00:00Z', remind_state: 'scheduled', action_id: null },
    ], now);
    expect(out).toEqual([]);
  });

  it('a mixed list keeps only the due rows and counts them', () => {
    const now = new Date('2026-11-06T16:00:00Z');
    const out = formatReminderLines([
      { id: 'future', title: 't', band: 'P0', due_at: '2026-11-07T16:00:00Z', remind_state: 'scheduled', action_id: null },
      { id: 'due-now', title: 't', band: 'P1', due_at: '2026-11-06T15:59:00Z', remind_state: 'scheduled', action_id: null },
    ], now).join('\n');
    expect(out).toContain('## Reminders due (1)');
    expect(out).not.toContain('future');
  });
});
