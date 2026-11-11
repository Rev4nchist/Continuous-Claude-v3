/**
 * lane-dep-banner: the SessionStart banner after the dependency gate (contract point 6 "Banner", open point 6).
 *
 * Ways it can fail:
 *   D1  the claimable query runs without openDepSql('l'), or lets go of owner_session_id IS NULL
 *   D2  the claimable query fails (no table lane_dep) and the hook drops the whole banner, or logs nothing
 *   D3  the "no lane" text still says `next`, or does not say claim by id with the board command
 *   D4  the Commands line still lists `next`, or lacks `done <id> [--merged <sha>]`
 *   D5  the claimable heading is still "Claimable next:"
 *
 * The database is a stub that records SQL. The SQL runs for real in the end-to-end check (hook-banner.json).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] | undefined }>,
  claimable: [] as Array<Record<string, unknown>>,
  failOn: null as RegExp | null,
}));

vi.mock('pg', () => {
  class Client {
    on(): this { return this; }
    async connect(): Promise<void> { /* connected */ }
    async end(): Promise<void> { /* closed */ }
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      fake.calls.push({ sql, params });
      if (fake.failOn && fake.failOn.test(sql)) throw Object.assign(new Error('relation "agentic_os.lane_dep" does not exist'), { code: '42P01' });
      // The claimable query is told apart first: its dependency fragment also names agentic_os.lane_event.
      if (/state IN \('ready','backlog'\)/.test(sql)) return { rows: fake.claimable };
      return { rows: [] };
    }
  }
  return { Client, default: { Client } };
});

import { runLaneContext } from '../lane-context.js';
import { openDepSql } from '../shared/lane-dep.js';

// An id no other test file uses: logLaneContextError throttles per session id through a stamp in os.tmpdir(),
// and lane-context-reminders.test.ts logs under aaaaaaaa-...-01 in a parallel worker.
const ME = 'dddddddd-0000-4000-8000-0000000000d2';
let tmp: string;
let ccv3: string;
const keys = ['LANE_REGISTRY_PATH', 'DATABASE_URL', 'CONTINUOUS_CLAUDE_DB_URL', 'CCV3_IDENTITY_DIR', 'CCV3_USER_HOME',
  'LANE_BOARD_CACHE', 'LANE_CONTEXT_ERROR_LOG', 'CLAUDE_CODE_ENTRYPOINT', 'LANE_CONTEXT_HEADLESS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of keys) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'lc-dep-'));
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
  fake.calls.length = 0; fake.claimable = []; fake.failOn = null;
});
afterEach(() => {
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(join(tmpdir(), `claude-lane-err-${ME}.json`), { force: true });
  rmSync(tmp, { recursive: true, force: true });
});

const start = async (): Promise<string> => {
  const out = (await runLaneContext(JSON.stringify({ session_id: ME, hook_event_name: 'SessionStart', cwd: ccv3 }))) as
    { hookSpecificOutput?: { additionalContext: string } };
  return out.hookSpecificOutput?.additionalContext ?? '';
};
const claimQuery = () => fake.calls.find((c) => /state IN \('ready','backlog'\)/.test(c.sql));
const fold = (s: string): string => s.replace(/\s+/g, ' ');

describe('D1: the claimable query', () => {
  it('carries openDepSql(l) and keeps owner_session_id IS NULL', async () => {
    await start();
    const sql = fold(claimQuery()?.sql ?? '');
    expect(sql, 'no claimable query ran').not.toBe('');
    expect(sql).toContain(`AND NOT ${openDepSql('l')}`);
    expect(sql).toContain('owner_session_id IS NULL');
    expect(claimQuery()?.params).toEqual(['continuous-claude']);
  });
});

describe('D2: a failing claimable query', () => {
  it('drops the claimable block, keeps the banner, and logs one line', async () => {
    fake.claimable = [{ id: 'c-1', title: 'claim me', band: 'P1' }];
    fake.failOn = /state IN \('ready','backlog'\)/;
    const t = await start();
    expect(t).toContain('## Lane board continuous-claude');
    expect(t).toContain('Commands:');
    expect(t).not.toContain('Claimable');
    expect(t).not.toContain('c-1');
    const log = process.env.LANE_CONTEXT_ERROR_LOG as string;
    expect(existsSync(log), 'no error line logged').toBe(true);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('D3-D5: the text', () => {
  it('D3: no lane held: claim by id, with the board command and no next', async () => {
    const t = await start();
    const cmd = 'node C:/Users/Tester/.claude/scripts/lane.mjs';
    expect(t).toContain('You hold no lane. Claim one by id before starting work:');
    expect(t).toContain(`  ${cmd} board --by priority`);
    expect(t).toContain(`  ${cmd} claim <id>`);
    expect(t).not.toContain('Claim one before starting work');
    expect(t).not.toMatch(/lane\.mjs next/);
  });

  it('D4: the Commands line has no next and shows done <id> [--merged <sha>]', async () => {
    const t = await start();
    const line = t.split('\n').find((l) => l.startsWith('Commands:')) ?? '';
    expect(line).toContain('board | claim <id> | note <id> "..." | say "..." | done <id> [--merged <sha>] | remind list|set|snooze|ack');
    expect(line).not.toMatch(/\bnext\b/);
  });

  it('D5: the claimable heading says claim by id and lists the row', async () => {
    fake.claimable = [{ id: 'c-1', title: 'claim me', band: 'P1' }];
    const t = await start();
    expect(t).toContain('Claimable (claim by id):');
    expect(t).not.toContain('Claimable next');
    expect(t).toMatch(/P1 c-1\s+claim me/);
  });
});
