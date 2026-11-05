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
 *   node scripts/coordination/scratch-db.mjs create --through 4
 * The test refuses any database whose name does not start with lanes_pr1_ (never the live database).
 * Run:  $env:LANE_TEST_DB_URL='<url from create>'; .\node_modules\.bin\vitest.cmd run src/__tests__/lane-context-db.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { runLaneContext } from '../lane-context.js';

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
