/**
 * lane-context against a REAL scratch database: the cursor SQL is run, not read.
 *
 * lane-context-board.test.ts checks the cursor SQL as text against a stub. A wrong starts_with or MAX that
 * still matches the text would pass there. This file runs the real hook function on a real database with two
 * boards and proves behaviour:
 *   D1  a direct message is delivered once across boards (T4), whichever board reads first
 *   D2  the DM cursor is the MAX over the bare row and every <id>@<board> row
 *   D3  a broadcast cursor is per board: reading board A does not hide board B's broadcasts
 *   D4  a session in an unregistered cwd gets its DMs on the same cursor (and none of them again on a board)
 *   D5  that read moves only the sentinel row <id>@: a CCv3 broadcast with a LOWER id than the DM is still delivered later
 *
 * Skipped unless LANE_TEST_DB_URL names a scratch database made by
 *   node scripts/coordination/scratch-db.mjs create --through 5
 * The test refuses any database whose name does not start with lanes_pr1_ (never the live database).
 * Run:  $env:LANE_TEST_DB_URL='<url from create>'; .\node_modules\.bin\vitest.cmd run src/__tests__/lane-context-db.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';

import { boardFallback, deliverDirectMessages, dmStatePath, noBoardFallback, runLaneContext } from '../lane-context.js';

// C10: the hook writes no cursor once process.uptime() passes 3.0 s. This worker is older than any hook, so every
// case runs with a young clock. A case that tests the clock sets its own.
beforeEach(() => { vi.spyOn(process, 'uptime').mockReturnValue(0.5); });
afterEach(() => { vi.restoreAllMocks(); });

const URL_ENV = process.env.LANE_TEST_DB_URL ?? '';
const dbName = (() => { try { return new URL(URL_ENV).pathname.replace(/^\//, ''); } catch { return ''; } })();
const usable = /^lanes_pr1_[a-z0-9_]+$/.test(dbName);
if (URL_ENV && !usable) throw new Error(`LANE_TEST_DB_URL must name a scratch database (lanes_pr1_*), got '${dbName}'`);

const ME = 'aaaaaaaa-0000-4000-8000-0000000000d1';
const PEER = 'bbbbbbbb-0000-4000-8000-0000000000d2';
const KEYS = ['LANE_REGISTRY_PATH', 'CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL', 'CCV3_IDENTITY_DIR',
  'LANE_BOARD_CACHE', 'LANE_CONTEXT_ERROR_LOG', 'CLAUDE_CODE_ENTRYPOINT', 'LANE_CONTEXT_HEADLESS'] as const;

describe.skipIf(!usable)('lane-context cursors on a scratch database (set LANE_TEST_DB_URL to a lanes_pr1_* database to run)', () => {
  const saved: Record<string, string | undefined> = {};
  let tmp = '';
  let ccv3 = '';
  let zz = '';
  let nowhere = '';
  let db: Client;
  const ids: Record<string, number> = {};

  const send = async (tag: string, board: string, to: string | null): Promise<void> => {
    const r = await db.query(
      `INSERT INTO agentic_os.lane_event (kind, session_id, to_session_id, body, project_key)
       VALUES ('note', $1, $2, $3, $4) RETURNING id`,
      [PEER, to, tag, board],
    );
    ids[tag] = Number(r.rows[0].id);
  };
  const prompt = async (cwd: string): Promise<string> => {
    const out = (await runLaneContext(JSON.stringify({ session_id: ME, hook_event_name: 'UserPromptSubmit', cwd }))) as
      { hookSpecificOutput?: { additionalContext: string } };
    return out.hookSpecificOutput?.additionalContext ?? '';
  };
  const marks = async (): Promise<Record<string, number>> => Object.fromEntries(
    (await db.query(
      'SELECT session_id, last_event_id FROM agentic_os.lane_watermark WHERE session_id = $1 OR starts_with(session_id, $1 || $2)',
      [ME, '@'],
    )).rows.map((r: { session_id: string; last_event_id: string }) => [r.session_id, Number(r.last_event_id)]),
  );

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    tmp = mkdtempSync(join(tmpdir(), 'lc-db-'));
    ccv3 = join(tmp, 'ccv3'); zz = join(tmp, 'zz'); nowhere = join(tmp, 'nowhere');
    for (const d of [ccv3, zz, nowhere]) mkdirSync(d, { recursive: true });
    writeFileSync(join(tmp, 'registry.json'), JSON.stringify({ projects: [
      { name: 'CCv3', key: 'continuous-claude', path: ccv3, status: 'active' },
      { name: 'ZZ', key: 'zz-board', path: zz, status: 'active' },
    ] }));
    process.env.LANE_REGISTRY_PATH = join(tmp, 'registry.json');
    process.env.CONTINUOUS_CLAUDE_DB_URL = URL_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.OPC_POSTGRES_URL;
    process.env.CCV3_IDENTITY_DIR = join(tmp, 'ident');
    process.env.LANE_BOARD_CACHE = '0';
    process.env.LANE_CONTEXT_ERROR_LOG = join(tmp, 'errors.jsonl');
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.LANE_CONTEXT_HEADLESS;

    db = new Client({ connectionString: URL_ENV });
    await db.connect();
    await db.query("SELECT set_config('lane.client_version', '2', false)");
    await cleanup();
    await send('zz-broadcast', 'zz-board', null);
    await send('zz-dm', 'zz-board', ME);
    await send('cc-broadcast', 'continuous-claude', null);
    await send('cc-dm', 'continuous-claude', ME);
  });

  const cleanup = async (): Promise<void> => {
    await db.query('DELETE FROM agentic_os.lane_event WHERE session_id = $1', [PEER]);
    await db.query('DELETE FROM agentic_os.lane_watermark WHERE session_id = $1 OR starts_with(session_id, $1 || $2)', [ME, '@']);
  };

  afterAll(async () => {
    try { await cleanup(); } finally { await db.end(); }
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('D1+D3: board zz reads its broadcast and BOTH DMs (one crossed boards); the cursor row is <id>@zz-board', async () => {
    const t = await prompt(zz);
    expect(t).toContain('zz-broadcast');
    expect(t).toContain('zz-dm');
    expect(t).toMatch(/\[from continuous-claude\][^\n]*cc-dm/);
    expect(t).not.toContain('cc-broadcast');
    expect(await marks()).toEqual({ [`${ME}@zz-board`]: ids['cc-dm'] });
  });

  it('D1+D2+D3: board continuous-claude shows ITS broadcast, and neither DM again (MAX across rows)', async () => {
    const t = await prompt(ccv3);
    expect(t).toContain('cc-broadcast');
    expect(t).not.toContain('zz-broadcast');
    expect(t).not.toContain('zz-dm');
    expect(t).not.toContain('cc-dm');
    expect(await marks()).toEqual({ [`${ME}@zz-board`]: ids['cc-dm'], [ME]: ids['cc-broadcast'] });
  });

  it('D1+D2: a new DM read on continuous-claude is not shown again on zz-board (zz row is behind it, the MAX is not)', async () => {
    await send('late-dm', 'zz-board', ME);
    expect(await prompt(ccv3)).toContain('late-dm');
    expect(await marks()).toMatchObject({ [ME]: ids['late-dm'], [`${ME}@zz-board`]: ids['cc-dm'] });
    expect(await prompt(zz)).toBe('');
  });

  it('D3: a later zz-board broadcast still reaches zz-board, with the DM it sits behind staying read', async () => {
    await send('zz-late-broadcast', 'zz-board', null);
    const t = await prompt(zz);
    expect(t).toContain('zz-late-broadcast');
    expect(t).not.toContain('late-dm');
  });

  it('D4: an unregistered cwd gets its DMs (no broadcasts), once, on the same cursor', async () => {
    await send('home-dm', 'continuous-claude', ME);
    await send('home-broadcast', 'continuous-claude', null);
    const t = await prompt(nowhere);
    expect(t).toContain('home-dm');
    expect(t).not.toContain('home-broadcast');
    expect(t).not.toContain('## Lane board');
    expect((await marks())[`${ME}@`]).toBe(ids['home-dm']);
    expect(await prompt(nowhere)).toBe('');
    expect(await prompt(zz)).not.toContain('home-dm');
  });

  it('D5: broadcast 500 then DM 501, DM read from an unregistered cwd: broadcast 500 still reaches continuous-claude', async () => {
    await send('haz-broadcast', 'continuous-claude', null);
    await send('haz-dm', 'continuous-claude', ME);
    expect(ids['haz-dm']).toBeGreaterThan(ids['haz-broadcast']);
    const before = (await marks())[ME];
    const home = await prompt(nowhere);
    expect(home).toContain('haz-dm');
    expect(home).not.toContain('haz-broadcast');
    const after = await marks();
    expect(after[ME]).toBe(before); // the bare row (continuous-claude broadcast cursor) did not move
    expect(after[`${ME}@`]).toBe(ids['haz-dm']);
    const cc = await prompt(ccv3);
    expect(cc).toContain('haz-broadcast');
    expect(cc).not.toContain('haz-dm');
  });
});

/**
 * The banner cursor on the real paging SQL (coord-banner-cursor). Each case has its own session, and clears its
 * own events first, so the cases do not depend on each other or on D1 to D5.
 *   D6   14 broadcasts then 1 DM: page 1 holds the DM and 11 broadcasts, page 2 the other 3, page 3 nothing
 *   D7   a cold start with 20 broadcasts and 3 DMs: the DMs and 9 of the newest 12; the next page the other 3
 *   D8   no board, 13 DMs: 12 now, 1 on the next prompt
 *   D9   a second connection moves the row further between the hook's read and its write: it does not move back
 *   D10  two boards: the DM cursor spans them, the broadcast cursors stay apart
 *   D11  a cold start with a cut DM: 13 DMs, then 40 broadcasts over three prompts; 1 to 49 never show
 * Bodies are `<tag>`, so a test reads the printed order and cannot confuse bc1 with bc11.
 */
describe.skipIf(!usable)('lane-context paging on a scratch database (D6 and up)', () => {
  const ME2 = 'aaaaaaaa-0000-4000-8000-0000000000e1';
  const PEER2 = 'bbbbbbbb-0000-4000-8000-0000000000e2';
  const SENT = `${ME2}@`;
  const saved: Record<string, string | undefined> = {};
  let tmp = '';
  let ccv3 = '';
  let zz = '';
  let nowhere = '';
  let db: Client;
  const ids: Record<string, number> = {};

  const send = async (tag: string, board: string, to: string | null): Promise<void> => {
    const r = await db.query(
      `INSERT INTO agentic_os.lane_event (kind, session_id, to_session_id, body, project_key)
       VALUES ('note', $1, $2, $3, $4) RETURNING id`,
      [PEER2, to, `<${tag}>`, board],
    );
    ids[tag] = Number(r.rows[0].id);
  };
  /** n events in id order: broadcasts `<prefix><i>` on `board`, or DMs to ME2 when `dm` is true. */
  const many = async (prefix: string, from: number, to: number, board: string, dm: boolean): Promise<void> => {
    for (let i = from; i <= to; i += 1) await send(`${prefix}${i}`, board, dm ? ME2 : null);
  };
  const seq = (prefix: string, from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
  const prompt = async (cwd: string): Promise<string> => {
    const out = (await runLaneContext(JSON.stringify({ session_id: ME2, hook_event_name: 'UserPromptSubmit', cwd }))) as
      { hookSpecificOutput?: { additionalContext: string } };
    return out.hookSpecificOutput?.additionalContext ?? '';
  };
  const tags = (t: string): string[] => [...t.matchAll(/<(\w+)>/g)].map((m) => m[1]);
  const marks = async (): Promise<Record<string, number>> => Object.fromEntries(
    (await db.query(
      'SELECT session_id, last_event_id FROM agentic_os.lane_watermark WHERE session_id = $1 OR starts_with(session_id, $1 || $2)',
      [ME2, '@'],
    )).rows.map((r: { session_id: string; last_event_id: string }) => [r.session_id, Number(r.last_event_id)]),
  );
  /** A warm board: a row at 0 exists, so board_wm is not NULL and the cold rule stays off. */
  const warm = async (key: string): Promise<void> => {
    await db.query('INSERT INTO agentic_os.lane_watermark (session_id, last_event_id) VALUES ($1, 0)', [key]);
  };
  const reset = async (): Promise<void> => {
    await db.query('DELETE FROM agentic_os.lane_event WHERE session_id = $1', [PEER2]);
    await db.query('DELETE FROM agentic_os.lane_watermark WHERE session_id = $1 OR starts_with(session_id, $1 || $2)', [ME2, '@']);
  };

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    tmp = mkdtempSync(join(tmpdir(), 'lc-db2-'));
    ccv3 = join(tmp, 'ccv3'); zz = join(tmp, 'zz'); nowhere = join(tmp, 'nowhere');
    for (const d of [ccv3, zz, nowhere]) mkdirSync(d, { recursive: true });
    writeFileSync(join(tmp, 'registry.json'), JSON.stringify({ projects: [
      { name: 'CCv3', key: 'continuous-claude', path: ccv3, status: 'active' },
      { name: 'ZZ', key: 'zz-board', path: zz, status: 'active' },
    ] }));
    process.env.LANE_REGISTRY_PATH = join(tmp, 'registry.json');
    process.env.CONTINUOUS_CLAUDE_DB_URL = URL_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.OPC_POSTGRES_URL;
    process.env.CCV3_IDENTITY_DIR = join(tmp, 'ident');
    process.env.LANE_BOARD_CACHE = '0';
    process.env.LANE_CONTEXT_ERROR_LOG = join(tmp, 'errors.jsonl');
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.LANE_CONTEXT_HEADLESS;
    db = new Client({ connectionString: URL_ENV });
    await db.connect();
    await db.query("SELECT set_config('lane.client_version', '2', false)");
  });
  beforeEach(reset);
  afterAll(async () => {
    try { await reset(); } finally { await db.end(); }
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('D6: 14 broadcasts then 1 DM: page 1 = DM + 11 broadcasts, page 2 = the other 3, page 3 = nothing', async () => {
    await warm(ME2);
    await many('bc', 1, 14, 'continuous-claude', false);
    await send('dm', 'continuous-claude', ME2);
    const p1 = await prompt(ccv3);
    expect(p1).toContain('## 15 lane update(s) since you last looked');
    expect(p1).toMatch(/\(direct to you\): <dm>/);
    expect(tags(p1)).toEqual([...seq('bc', 1, 11), 'dm']);
    // Warm board: the row exists, so the line names `inbox`.
    expect(p1).toMatch(/\(3 more unread\. Later prompts show them, oldest first, or run: .*lane\.mjs inbox\)/);
    expect(await marks()).toEqual({ [ME2]: ids.bc11, [SENT]: ids.dm });
    const p2 = await prompt(ccv3);
    expect(tags(p2)).toEqual(seq('bc', 12, 14));
    expect(p2).not.toMatch(/more unread/);
    expect(await marks()).toEqual({ [ME2]: ids.bc14, [SENT]: ids.dm });
    expect(await prompt(ccv3)).toBe('');
  });

  it('D7: cold, 20 broadcasts then 3 DMs: the DMs and 9 of the newest 12; next page the other 3, nothing older', async () => {
    await many('bc', 1, 20, 'continuous-claude', false);
    await many('dm', 1, 3, 'continuous-claude', true);
    const p1 = await prompt(ccv3);
    expect(tags(p1)).toEqual([...seq('bc', 9, 17), ...seq('dm', 1, 3)]);
    expect(p1).toContain('## 15 lane update(s) since you last looked');
    expect(p1).toContain('(8 older board events are not shown on your first look at this board.)');
    expect(p1).toContain('(3 more unread. Later prompts show them');
    expect(await marks()).toEqual({ [ME2]: ids.bc17, [SENT]: ids.dm3 });
    const p2 = await prompt(ccv3);
    expect(tags(p2)).toEqual(seq('bc', 18, 20));
    expect(p2).not.toMatch(/not shown on your first look/);
    expect(await prompt(ccv3)).toBe('');
  });

  it('D8: no board, 13 DMs: 12 on this prompt, 1 on the next, none after', async () => {
    await many('dm', 1, 13, 'continuous-claude', true);
    const p1 = await prompt(nowhere);
    expect(tags(p1)).toEqual(seq('dm', 1, 12));
    expect(p1).toContain('## 13 lane update(s) since you last looked');
    expect(await marks()).toEqual({ [SENT]: ids.dm12 });
    expect(tags(await prompt(nowhere))).toEqual(['dm13']);
    expect(await marks()).toEqual({ [SENT]: ids.dm13 });
    expect(await prompt(nowhere)).toBe('');
  });

  it('D9: a second connection moves the row further between the read and the write: the row does not move back', async () => {
    // Five events fit on one page, so the page is the same before and after the change. Only the write differs.
    await warm(ME2);
    await many('bc', 1, 5, 'continuous-claude', false);
    const far = ids.bc5 + 1000;
    const holder = new Client({ connectionString: URL_ENV });
    await holder.connect();
    let pending: Promise<string> | undefined;
    try {
      // The row is locked with the new value before the hook starts. The hook reads the OLD value (the update is
      // not committed), then its write waits on the lock. The commit lets the write run against the new row.
      await holder.query('BEGIN');
      await holder.query('UPDATE agentic_os.lane_watermark SET last_event_id = $1 WHERE session_id = $2', [far, ME2]);
      pending = prompt(ccv3);
      let waiting = false;
      for (let i = 0; i < 40 && !waiting; i += 1) {
        await new Promise((res) => setTimeout(res, 25));
        waiting = (await db.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $1`,
          ['%INSERT INTO agentic_os.lane_watermark%'],
        )).rows.length > 0;
      }
      expect(waiting, 'the hook write never reached the row lock').toBe(true);
      await holder.query('COMMIT');
      const t = await pending;
      expect(tags(t)).toEqual(seq('bc', 1, 5));
    } finally {
      // The ROLLBACK frees the row lock, so a pending prompt that never got its COMMIT can finish. Settle it before
      // the next test resets the rows, or its write lands in that test. A rejection here must not hide the real failure.
      await holder.query('ROLLBACK').catch(() => {});
      await pending?.catch(() => {});
      await holder.end();
    }
    expect((await marks())[ME2]).toBe(far);
  });

  it('D10: two boards: the DM cursor spans them, the broadcast cursors stay apart', async () => {
    await warm(ME2);
    await many('y', 1, 12, 'zz-board', false);
    await many('d', 1, 13, 'continuous-claude', true);
    await many('x', 1, 6, 'continuous-claude', false);
    const px = await prompt(ccv3);
    expect(tags(px)).toEqual(seq('d', 1, 12));
    expect(await marks()).toEqual({ [ME2]: ids.d12 });
    const py = await prompt(zz);
    expect(tags(py)).toEqual([...seq('y', 1, 11), 'd13']);
    expect(await marks()).toEqual({ [ME2]: ids.d12, [`${ME2}@zz-board`]: ids.y11, [SENT]: ids.d13 });
    expect(tags(await prompt(ccv3))).toEqual(seq('x', 1, 6));
    expect(tags(await prompt(zz))).toEqual(['y12']);
    expect(await prompt(ccv3)).toBe('');
    expect(await prompt(zz)).toBe('');
  });

  it('D11: cold with a cut DM: only the sentinel is written; the old broadcasts never show; the cut DM and the newest follow', async () => {
    await many('bc', 1, 49, 'continuous-claude', false);
    await many('dm', 50, 62, 'continuous-claude', true);
    await many('bc', 63, 100, 'continuous-claude', false);
    const p1 = await prompt(ccv3);
    expect(tags(p1)).toEqual(seq('dm', 50, 61));
    // Page 1 writes no board row: no cold line yet, and no `inbox` (it has no cold rule). A cold page that cuts a
    // direct message and board events (ROW 46) must not promise that the board events show later.
    expect(p1).toContain('  (13 more unread, 1 direct to you. Later prompts show the direct ones, oldest first. The board events show only while they are among the newest 12 of this board.)');
    expect(p1).not.toMatch(/inbox|not shown on your first look/);
    expect(await marks()).toEqual({ [SENT]: ids.dm61 });
    const p2 = await prompt(ccv3);
    expect(tags(p2)).toEqual(['dm62', ...seq('bc', 89, 99)]);
    // Page 2 writes the board row: the cold line prints here, once.
    expect(p2).toContain('(75 older board events are not shown on your first look at this board.)');
    // C9: page 2 writes the board row, so the line names `inbox`.
    expect(p2).toMatch(/\(1 more unread\. Later prompts show them, oldest first, or run: .*lane\.mjs inbox\)/);
    expect(await marks()).toEqual({ [ME2]: ids.bc99, [SENT]: ids.dm61 });
    const p3 = await prompt(ccv3);
    expect(tags(p3)).toEqual(['bc100']);
    expect(p3).not.toMatch(/not shown on your first look/);
    expect(await prompt(ccv3)).toBe('');
  });

  it('D12 (seat row 47): the mid-turn page shows the newest 5 of 7 DMs and marks none as read; the next prompt shows all 7, oldest first', async () => {
    await warm(ME2);
    await many('dm', 1, 7, 'continuous-claude', true);
    rmSync(dmStatePath(ME2), { force: true });
    let mid = '';
    try {
      await deliverDirectMessages(ME2, Date.now(), (context) => { mid = context; });
    } finally {
      rmSync(dmStatePath(ME2), { force: true });
    }
    expect(tags(mid)).toEqual(seq('dm', 3, 7));
    expect(mid).toContain('(2 older not shown. The next prompt shows your direct messages, oldest first, up to 12 at a time.)');
    // The mid-turn page wrote no cursor: the warm row is still at 0 and no sentinel row exists. So its line is true.
    expect(await marks()).toEqual({ [ME2]: 0 });
    expect(tags(await prompt(ccv3))).toEqual(seq('dm', 1, 7));
    expect(await prompt(ccv3)).toBe('');
  });
});

/**
 * Byte budgets on the real SQL (coord-banner-page-budget, CONTRACT v2). Own session ids; each case clears its rows.
 *   D13 (F1, F8)  50 direct messages: whole messages only, oldest first, no board event while one waits, none lost
 *   D14 (F3)      a text over its budget sends the fallback and moves no cursor, on the board and no-board paths
 *   D15 (F7)      one 9,000-byte direct message: page 1 shows it alone and cut, page 2 shows the next event
 *   D16 (F1)      board events the share rule removes stay unread and show on the next page
 *   D17 (F15)     SessionStart and the first prompt at the same time: an event may show twice, never "read, not shown"
 */
describe.skipIf(!usable)('lane-context byte budgets on a scratch database (D13 and up)', () => {
  const ME3 = 'aaaaaaaa-0000-4000-8000-0000000000f1';
  const PEER3 = 'bbbbbbbb-0000-4000-8000-0000000000f2';
  const saved: Record<string, string | undefined> = {};
  let tmp = '';
  let ccv3 = '';
  let nowhere = '';
  let db: Client;
  const ids: Record<string, number> = {};
  const bodies: Record<string, string> = {};
  const bytes = (t: string): number => Buffer.byteLength(t, 'utf8');
  const MARKER = / …\[cut, (\d+) more bytes\. Full text: .*lane\.mjs inbox --id (\d+)\]$/;

  const send = async (tag: string, to: string | null, pad = ''): Promise<void> => {
    const body = `<${tag}>${pad}`;
    const r = await db.query(
      `INSERT INTO agentic_os.lane_event (kind, session_id, to_session_id, body, project_key)
       VALUES ('note', $1, $2, $3, 'continuous-claude') RETURNING id`,
      [PEER3, to, body],
    );
    ids[tag] = Number(r.rows[0].id);
    bodies[tag] = body;
  };
  const run = async (event: string, cwd: string, opts?: Parameters<typeof runLaneContext>[1]): Promise<string> => {
    const out = (await runLaneContext(JSON.stringify({ session_id: ME3, hook_event_name: event, cwd }), opts)) as
      { hookSpecificOutput?: { additionalContext: string } };
    return out.hookSpecificOutput?.additionalContext ?? '';
  };
  const tags = (t: string): string[] => [...t.matchAll(/<((?:bc|dm|big)\d*)>/g)].map((m) => m[1]);
  const seq = (prefix: string, from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
  const marks = async (): Promise<Record<string, number>> => Object.fromEntries(
    (await db.query(
      'SELECT session_id, last_event_id FROM agentic_os.lane_watermark WHERE session_id = $1 OR starts_with(session_id, $1 || $2)',
      [ME3, '@'],
    )).rows.map((r: { session_id: string; last_event_id: string }) => [r.session_id, Number(r.last_event_id)]),
  );
  const maxMark = async (): Promise<number> => Math.max(0, ...Object.values(await marks()));
  const warm = async (): Promise<void> => {
    await db.query('INSERT INTO agentic_os.lane_watermark (session_id, last_event_id) VALUES ($1, 0)', [ME3]);
  };
  const reset = async (): Promise<void> => {
    await db.query('DELETE FROM agentic_os.lane_event WHERE session_id = $1', [PEER3]);
    await db.query('DELETE FROM agentic_os.lane_watermark WHERE session_id = $1 OR starts_with(session_id, $1 || $2)', [ME3, '@']);
  };

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    tmp = mkdtempSync(join(tmpdir(), 'lc-db3-'));
    ccv3 = join(tmp, 'ccv3'); nowhere = join(tmp, 'nowhere');
    for (const d of [ccv3, nowhere]) mkdirSync(d, { recursive: true });
    writeFileSync(join(tmp, 'registry.json'), JSON.stringify({ projects: [
      { name: 'CCv3', key: 'continuous-claude', path: ccv3, status: 'active' },
    ] }));
    process.env.LANE_REGISTRY_PATH = join(tmp, 'registry.json');
    process.env.CONTINUOUS_CLAUDE_DB_URL = URL_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.OPC_POSTGRES_URL;
    process.env.CCV3_IDENTITY_DIR = join(tmp, 'ident');
    process.env.LANE_BOARD_CACHE = '0';
    process.env.LANE_CONTEXT_ERROR_LOG = join(tmp, 'errors.jsonl');
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.LANE_CONTEXT_HEADLESS;
    db = new Client({ connectionString: URL_ENV });
    await db.connect();
    await db.query("SELECT set_config('lane.client_version', '2', false)");
  });
  beforeEach(reset);
  afterAll(async () => {
    try { await reset(); } finally { await db.end(); }
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('D13 (F1, F8): 50 direct messages page whole, oldest first; no board event while one waits; none lost', async () => {
    await warm();
    for (let i = 1; i <= 3; i += 1) await send(`bc${i}`, null);
    const pad = 'm'.repeat(900);
    for (let i = 1; i <= 50; i += 1) await send(`dm${i}`, ME3, pad);
    const seen: string[] = [];
    for (let page = 0; page < 30; page += 1) {
      const t = await run('UserPromptSubmit', ccv3);
      if (!t) break;
      expect(bytes(t), `page ${page} bytes`).toBeLessThanOrEqual(6000);
      expect(t).not.toMatch(/\[cut,/);
      const got = tags(t);
      const dmsHere = got.filter((x) => x.startsWith('dm'));
      for (const d of dmsHere) expect(t).toContain(bodies[d]);
      expect(dmsHere).toEqual(seq('dm', seen.filter((x) => x.startsWith('dm')).length + 1, seen.filter((x) => x.startsWith('dm')).length + dmsHere.length));
      seen.push(...got);
      const dmsLeft = 50 - seen.filter((x) => x.startsWith('dm')).length;
      if (dmsLeft > 0) {
        expect(got.some((x) => x.startsWith('bc')), `page ${page} shows a board event while a DM waits`).toBe(false);
        // C1: no cursor row passes the oldest DM that waits.
        expect(await maxMark()).toBeLessThan(ids[`dm${51 - dmsLeft}`]);
      }
    }
    // A page prints in id order, and the broadcasts have the lower ids: compare the two kinds apart.
    expect(seen.filter((x) => x.startsWith('dm'))).toEqual(seq('dm', 1, 50));
    expect(seen.filter((x) => x.startsWith('bc'))).toEqual(seq('bc', 1, 3));
    expect(seen).toHaveLength(53);
    expect(await run('UserPromptSubmit', ccv3)).toBe('');
  });

  it('D14 (F3): over its budget a page sends the fallback and moves no cursor (board and no-board); the next page shows all', async () => {
    await warm();
    for (let i = 1; i <= 3; i += 1) await send(`bc${i}`, null, 'x'.repeat(100));
    await send('dm1', ME3, 'hello');
    const before = await marks();
    expect(await run('UserPromptSubmit', ccv3, { budgets: { prompt: 100 } }))
      .toBe(boardFallback('continuous-claude', `#${ME3.slice(0, 8)}`, ids.dm1));
    expect(await marks()).toEqual(before);
    expect(await run('UserPromptSubmit', nowhere, { budgets: { noBoard: 60 } })).toBe(noBoardFallback(ids.dm1));
    expect(await marks()).toEqual(before);
    expect(tags(await run('UserPromptSubmit', ccv3))).toEqual(['bc1', 'bc2', 'bc3', 'dm1']);
    expect(await run('UserPromptSubmit', ccv3)).toBe('');
  });

  it('D15 (F7): one 9,000-byte DM: page 1 shows it alone and cut, page 2 shows the next event, page 3 nothing', async () => {
    await warm();
    await send('big', ME3, 'y'.repeat(9000));
    await send('bc1', null, 'after');
    const p1 = await run('UserPromptSubmit', ccv3);
    expect(bytes(p1)).toBeLessThanOrEqual(6000);
    expect(tags(p1)).toEqual(['big']);
    const line = p1.split('\n').find((l) => l.includes('<big>')) ?? '';
    const m = line.match(MARKER);
    expect(m, 'the cut DM has no marker').not.toBeNull();
    expect(Number(m![2])).toBe(ids.big);
    const stored = (await db.query('SELECT body FROM agentic_os.lane_event WHERE id = $1', [ids.big])).rows[0].body as string;
    const kept = line.slice(line.indexOf('<big>'), line.length - m![0].length);
    expect(stored.startsWith(kept)).toBe(true);
    expect(bytes(kept) + Number(m![1])).toBe(bytes(stored));
    expect(await maxMark()).toBe(ids.big);
    expect(tags(await run('UserPromptSubmit', ccv3))).toEqual(['bc1']);
    expect(await run('UserPromptSubmit', ccv3)).toBe('');
  });

  it('D16 (F1): board events that the share rule removes stay unread and show on the next page', async () => {
    await warm();
    for (let i = 1; i <= 12; i += 1) await send(`bc${i}`, null, 'k'.repeat(2000));
    const seen: string[] = [];
    let pages = 0;
    for (; pages < 12; pages += 1) {
      const t = await run('UserPromptSubmit', ccv3, { budgets: { prompt: 3000 } });
      if (!t) break;
      expect(bytes(t)).toBeLessThanOrEqual(3000);
      const got = tags(t);
      expect(got.length).toBeGreaterThan(0);
      for (const l of t.split('\n').filter((x) => x.startsWith('- '))) expect(l).toMatch(MARKER);
      seen.push(...got);
      // The board row is the last event shown: never past a removed one.
      expect((await marks())[ME3]).toBe(ids[got[got.length - 1]]);
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(seq('bc', 1, 12));
  });

  it('D17 (F15): SessionStart and the first prompt at once: every event marked read shows in a text; none is lost', async () => {
    await warm();
    for (let i = 1; i <= 3; i += 1) await send(`bc${i}`, null);
    for (let i = 1; i <= 2; i += 1) await send(`dm${i}`, ME3);
    const [s, p] = await Promise.all([run('SessionStart', ccv3), run('UserPromptSubmit', ccv3)]);
    const shown = new Set([...tags(s), ...tags(p)]);
    const m = await marks();
    const boardRow = m[ME3] ?? 0;
    const dmMark = Math.max(0, ...Object.values(m));
    for (const tag of [...seq('bc', 1, 3), ...seq('dm', 1, 2)]) {
      const read = tag.startsWith('dm') ? ids[tag] <= dmMark : ids[tag] <= boardRow;
      if (read) expect(shown.has(tag), `${tag} is marked read but was not shown`).toBe(true);
    }
    const later = tags(await run('UserPromptSubmit', ccv3));
    for (const tag of later) shown.add(tag);
    expect([...shown].sort()).toEqual([...seq('bc', 1, 3), ...seq('dm', 1, 2)].sort());
  });

  it('D18 (C5c): a whole DM, then 10 claims with a NULL body: no page is the fallback, and two prompts show every event', async () => {
    // A plain `claim` writes a NULL body. Their line prefixes must fit the space the DM leaves, or the page is the
    // fallback with no cursor write, on every prompt. The DM sizes span the band where the prefixes do not fit.
    const failed: string[] = [];
    for (let pad = 5100; pad <= 5700; pad += 50) {
      await reset();
      await warm();
      await send('dm1', ME3, 'm'.repeat(pad));
      for (let i = 1; i <= 10; i += 1) {
        await db.query(
          `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, project_key)
           VALUES ($1, 'claimed', $2, NULL, NULL, 'continuous-claude')`,
          [`claimed-lane-with-a-long-id-${i}`, PEER3],
        );
      }
      const top = Number((await db.query('SELECT max(id) AS n FROM agentic_os.lane_event WHERE session_id = $1', [PEER3])).rows[0].n);
      const p1 = await run('UserPromptSubmit', ccv3);
      const p2 = await run('UserPromptSubmit', ccv3);
      const shown = [p1, p2].flatMap((t) => t.split('\n').filter((l) => l.startsWith('- '))).length;
      if (/over its budget/.test(p1) || bytes(p1) > 6000 || shown !== 11 || (await marks())[ME3] !== top) {
        failed.push(`pad ${pad}: ${shown} shown`);
      }
    }
    expect(failed).toEqual([]);
  });
});
