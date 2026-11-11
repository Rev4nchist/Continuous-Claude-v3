/**
 * lane-dep-banner: the SessionStart banner after the dependency gate (contract point 6 "Banner", open point 6).
 *
 * Ways it can fail:
 *   D1  the claimable query runs without openDepSql('l'), or lets go of owner_session_id IS NULL
 *   D2  the claimable query fails (no table lane_dep) and the hook drops the whole banner, or logs nothing
 *   D3  the "no lane" text still says `next`, or is not the three standard lines L1 to L3 (kanban-sync, mine, board, add)
 *   D4  the Commands line still lists `next`, or lacks `done <id> [--merged <sha>]`
 *   D5  the claimable heading is still "Claimable next:"
 *   D12 the Milestone line is missing on a hold, prints with no lane held, or does not sit after `You hold:`
 *   D13 the Related line is missing, wrong on a null owner or an unknown id, lists a lane the session holds itself,
 *       is not capped at 8 ids, or a failing lookup drops the banner
 *   D14 parseRelatesTo: last marker, separators, trailing full stop, bad characters, duplicates, empty input
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
  /** Lanes the session holds (the `mine` query). */
  mine: [] as Array<Record<string, unknown>>,
  /** Rows the Related lookup returns: SELECT id, owner_session_id FROM agentic_os.lane WHERE id = ANY($1::text[]). */
  lookup: [] as Array<Record<string, unknown>>,
}));

vi.mock('pg', () => {
  class Client {
    on(): this { return this; }
    async connect(): Promise<void> { /* connected */ }
    async end(): Promise<void> { /* closed */ }
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      fake.calls.push({ sql, params });
      if (fake.failOn && fake.failOn.test(sql)) throw Object.assign(new Error('relation "agentic_os.lane_dep" does not exist'), { code: '42P01' });
      if (/FROM agentic_os\.lane WHERE id = ANY/.test(sql)) return { rows: fake.lookup };
      if (/owner_session_id=\$1 AND state<>'done' ORDER BY/.test(sql)) return { rows: fake.mine };
      // The claimable query is told apart first: its dependency fragment also names agentic_os.lane_event.
      if (/state IN \('ready','backlog'\)/.test(sql)) return { rows: fake.claimable };
      return { rows: [] };
    }
  }
  return { Client, default: { Client } };
});

import { parseRelatesTo, runLaneContext } from '../lane-context.js';
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
  fake.calls.length = 0; fake.claimable = []; fake.failOn = null; fake.mine = []; fake.lookup = [];
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
  it('D3: no lane held: the three standard lines L1 to L3, claim by id, and no next', async () => {
    const t = await start();
    const cmd = 'node C:/Users/Tester/.claude/scripts/lane.mjs';
    const L1 = `You hold no lane. 1. kanban-sync when the board has a phone page. 2. ${cmd} mine. 3. ${cmd} board --by priority, then claim the lane for your work by id.`;
    const L2 = `No lane for it: ${cmd} add <new-id> --title "..." --scope "..." only when ${cmd} board --all shows the id in no state, then claim it. Never add on a lane you do not hold.`;
    const L3 = 'Rules: lane-board.md. Rule ids: docs/coordination/standard.md.';
    expect(t).toContain([L1, L2, L3].join('\n'));
    expect(t).not.toContain('Claim one by id before starting work');
    expect(t).not.toContain(`  ${cmd} claim <id>`);
    expect(t).not.toContain('Claim one before starting work');
    expect(t).not.toMatch(/lane\.mjs next/);
    expect(t, 'the Milestone line must not print with no lane held').not.toContain('Milestone');
    expect(t).not.toContain('Related:');
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

const MILESTONE = 'Milestone (start, commit, decision by Dave, finding, block, done): send one DM to each holder in your RELATES TO list (M4.11).';
const heldLane = (id: string, scope: string | null): Record<string, unknown> =>
  ({ id, title: 't', track: 'x', state: 'active', scope, band: 'P1', project_key: 'continuous-claude', owner_session_id: ME });
const lookupCall = () => fake.calls.find((c) => /FROM agentic_os\.lane WHERE id = ANY/.test(c.sql));
const OWNER = 'cccccccc-0000-4000-8000-0000000000c3';

describe('D12: the Milestone line', () => {
  it('prints on the line after `You hold:` when the session holds a lane on this board', async () => {
    fake.mine = [heldLane('my-1', 'build it')];
    const lines = (await start()).split('\n');
    const hold = lines.findIndex((l) => l.startsWith('You hold: '));
    expect(hold, 'no You hold line').toBeGreaterThan(-1);
    expect(lines[hold]).toBe('You hold: P1 my-1');
    expect(lines[hold + 1]).toBe(MILESTONE);
  });

  it('does not print when the session holds a lane only on another board', async () => {
    fake.mine = [{ ...heldLane('other-1', null), project_key: 'zz-board' }];
    const t = await start();
    expect(t).toContain('You hold no lane.');
    expect(t).not.toContain('Milestone');
  });
});

describe('D13: the Related line', () => {
  it('names the holder, "no holder" for a null owner, "no such lane" for an unknown id; drops my own lanes; one query', async () => {
    fake.mine = [heldLane('my-1', 'build it. RELATES TO: a-1, b-2, c-3, my-1, a-1.')];
    fake.lookup = [{ id: 'a-1', owner_session_id: OWNER }, { id: 'b-2', owner_session_id: null }];
    const lines = (await start()).split('\n');
    const m = lines.indexOf(MILESTONE);
    expect(m, 'no Milestone line').toBeGreaterThan(-1);
    expect(lines[m + 1]).toBe('Related: a-1 (#cccccccc), b-2 (no holder), c-3 (no such lane)');
    const calls = fake.calls.filter((c) => /FROM agentic_os\.lane WHERE id = ANY/.test(c.sql));
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([['a-1', 'b-2', 'c-3']]);
    expect(fold(calls[0].sql)).toContain('SELECT id, owner_session_id FROM agentic_os.lane WHERE id = ANY($1::text[])');
  });

  it('prints no Related line and runs no lookup when no held scope has RELATES TO', async () => {
    fake.mine = [heldLane('my-1', 'build it'), heldLane('my-2', null)];
    const t = await start();
    expect(t).toContain(MILESTONE);
    expect(t).not.toContain('Related:');
    expect(lookupCall()).toBeUndefined();
  });

  it('prints no Related line when every listed id is a lane the session holds', async () => {
    fake.mine = [heldLane('my-1', 'RELATES TO: my-2'), heldLane('my-2', 'RELATES TO: my-1')];
    const t = await start();
    expect(t).toContain(MILESTONE);
    expect(t).not.toContain('Related:');
  });

  it('collects the ids of every held lane, in order of first use', async () => {
    fake.mine = [heldLane('my-1', 'RELATES TO: x-1, y-1'), heldLane('my-2', 'RELATES TO: y-1, z-1')];
    await start();
    expect(lookupCall()?.params).toEqual([['x-1', 'y-1', 'z-1']]);
  });

  it('shows at most 8 ids, then ", +N more"', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `r-${i + 1}`);
    fake.mine = [heldLane('my-1', `RELATES TO: ${ids.join(', ')}`)];
    const line = (await start()).split('\n').find((l) => l.startsWith('Related:')) ?? '';
    expect(line).toMatch(/, \+2 more$/);
    expect(line.match(/\(no such lane\)/g)).toHaveLength(8);
    expect(line).toContain('r-8 (no such lane)');
    expect(line).not.toContain('r-9');
  });

  it('a failing lookup drops the Related line, keeps the rest of the banner, and logs one line', async () => {
    fake.mine = [heldLane('my-1', 'RELATES TO: a-1')];
    fake.failOn = /FROM agentic_os\.lane WHERE id = ANY/;
    const t = await start();
    expect(t).toContain('## Lane board continuous-claude');
    expect(t).toContain(MILESTONE);
    expect(t).toContain('Commands:');
    expect(t).not.toContain('Related:');
    const log = process.env.LANE_CONTEXT_ERROR_LOG as string;
    expect(existsSync(log), 'no error line logged').toBe(true);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('D14: parseRelatesTo', () => {
  it('returns [] for null, undefined, empty text and text with no marker', () => {
    expect(parseRelatesTo(null)).toEqual([]);
    expect(parseRelatesTo(undefined)).toEqual([]);
    expect(parseRelatesTo('')).toEqual([]);
    expect(parseRelatesTo('build the thing, a-1 and b-2')).toEqual([]);
  });

  it('splits on commas and white space, and strips one trailing full stop', () => {
    expect(parseRelatesTo('scope. RELATES TO: a-1, b-2 c.3,d_4.')).toEqual(['a-1', 'b-2', 'c.3', 'd_4']);
  });

  it('reads the text after the LAST marker only', () => {
    expect(parseRelatesTo('RELATES TO: old-1, old-2. more text. RELATES TO: new-1')).toEqual(['new-1']);
  });

  it('keeps only ids made of letters, digits, dot, underscore and hyphen', () => {
    expect(parseRelatesTo('RELATES TO: ok-1, bad/2, (c), d:e, f@g, h-2')).toEqual(['ok-1', 'h-2']);
  });

  it('removes duplicates and keeps the order of first use', () => {
    expect(parseRelatesTo('RELATES TO: b-1, a-1, b-1, a-1.')).toEqual(['b-1', 'a-1']);
  });
});
