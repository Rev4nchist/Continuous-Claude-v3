/**
 * lane-context is board-aware (PR2).
 *
 * Failure list, one test (or group) each:
 *   B1  the client does not tell the 0004 trigger who it is (set_config lane.client_version) BEFORE the renew
 *   B2  the lease renew gained a board filter (a lane held from another cwd would lapse after 90 min)
 *   B3  the board is resolved BEFORE the renew: a headless or unregistered session lapses its leases (T6)
 *       an interactive session in an unregistered cwd loses its direct messages (it gets DMs only, no banner)
 *   B4  a headless session gets a banner or a DM instead of {}; an unregistered one gets a banner or broadcasts
 *   B5  unread events use their own SQL instead of lane.mjs UNREAD_SQL (cursors drift between CLI and hook)
 *   B6  the watermark write uses the bare id on a non-default board (rewinds CCv3's cursor, hides broadcasts)
 *   B7  claimable and peers are not filtered by board
 *   B8  "You hold" mixes boards; other boards' lanes are hidden instead of summarised
 *   B9  hints print the relative lane.mjs path instead of the shim
 *   B10 the board header does not name the board
 *   B11 a failure is silent forever (no throttled error line) or logs on every prompt
 *   B12 the per-session resolver cache serves the old board after a cd
 *   B13 the mid-turn DM cursor reads only the bare row (a DM already read on board B shows again)
 *   B14 session-register says nothing about the board, or calls an unregistered folder a board, or hits the DB
 *   B15 the same-name adopt hint prints the relative lane.mjs path
 *
 * The database is a stub that records SQL and parameters. The cursor SQL runs for real in lane-context-db.test.ts
 * (scratch database), project-board-probe.mjs and dm-delivery-probe.mjs.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] | undefined }>,
  mine: [] as Array<Record<string, unknown>>,
  claimable: [] as Array<Record<string, unknown>>,
  unread: [] as Array<Record<string, unknown>>,
  failOn: null as RegExp | null,
}));

vi.mock('pg', () => {
  class Client {
    on(): this { return this; }
    async connect(): Promise<void> { /* connected */ }
    async end(): Promise<void> { /* closed */ }
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      fake.calls.push({ sql, params });
      if (fake.failOn && fake.failOn.test(sql)) throw Object.assign(new Error('boom: ' + sql.slice(0, 30)), { code: '42501' });
      if (/FROM sessions s/.test(sql)) return { rows: [{ sid: 'bbbbbbbb-0000-4000-8000-000000000002', lanes: 'zz-1', scopes: 'src', total: 1 }] };
      if (/FROM agentic_os\.lane_event e\b/.test(sql)) return { rows: fake.unread };
      if (/state IN \('ready','backlog'\)/.test(sql)) return { rows: fake.claimable };
      if (/WHERE owner_session_id=\$1 AND state<>'done'/.test(sql)) return { rows: fake.mine };
      return { rows: [] };
    }
  }
  return { Client, default: { Client } };
});

import { runLaneContext, deliverDirectMessages, dmStatePath } from '../lane-context.js';
import { writeIdentity } from '../shared/session-identity.js';
import { laneBoardLine, sameNameHint } from '../shared/session-names.js';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const SRC_LANE_MJS = readFileSync(join(__dirname, '../../../../scripts/coordination/lane.mjs'), 'utf8');

let tmp: string;
let ccv3: string;
let zz: string;
let nowhere: string;
const keys = ['LANE_REGISTRY_PATH', 'DATABASE_URL', 'CONTINUOUS_CLAUDE_DB_URL', 'CCV3_IDENTITY_DIR', 'CCV3_USER_HOME',
  'LANE_BOARD_CACHE', 'LANE_CONTEXT_ERROR_LOG', 'CLAUDE_CODE_ENTRYPOINT', 'LANE_CONTEXT_HEADLESS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of keys) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'lc-board-'));
  ccv3 = join(tmp, 'ccv3'); zz = join(tmp, 'zz'); nowhere = join(tmp, 'nowhere');
  for (const d of [ccv3, zz, nowhere]) mkdirSync(d, { recursive: true });
  writeFileSync(join(tmp, 'registry.json'), JSON.stringify({ projects: [
    { name: 'CCv3', key: 'continuous-claude', path: ccv3, status: 'active' },
    { name: 'ZZ', key: 'zz-board', path: zz, status: 'active' },
  ] }));
  process.env.LANE_REGISTRY_PATH = join(tmp, 'registry.json');
  process.env.DATABASE_URL = 'postgres://stub@127.0.0.1:1/stub';
  delete process.env.CONTINUOUS_CLAUDE_DB_URL;
  process.env.CCV3_IDENTITY_DIR = join(tmp, 'ident');
  process.env.CCV3_USER_HOME = 'C:/Users/Tester';
  process.env.LANE_BOARD_CACHE = '0';
  process.env.LANE_CONTEXT_ERROR_LOG = join(tmp, 'errors.jsonl');
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.LANE_CONTEXT_HEADLESS;
  fake.calls.length = 0; fake.mine = []; fake.claimable = []; fake.unread = []; fake.failOn = null;
});
afterEach(() => {
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

const run = async (event: string, cwd: string, extra: object = {}): Promise<{ hookSpecificOutput?: { additionalContext: string } }> =>
  (await runLaneContext(JSON.stringify({ session_id: ME, hook_event_name: event, cwd, ...extra }))) as never;
const text = (o: { hookSpecificOutput?: { additionalContext: string } }): string => o.hookSpecificOutput?.additionalContext ?? '';
const idx = (re: RegExp): number => fake.calls.findIndex((c) => re.test(c.sql));
const RENEW = /UPDATE agentic_os\.lane\s+SET lease_expires_at/;

describe('B1-B4: order is a test, not a comment', () => {
  it('B1: set_config lane.client_version runs first, before the renew', async () => {
    await run('UserPromptSubmit', ccv3);
    const cfg = idx(/set_config\('lane\.client_version',\s*'2',\s*false\)/);
    expect(cfg).toBe(0);
    expect(idx(RENEW)).toBeGreaterThan(cfg);
  });

  it('B2: the renew has no board filter', async () => {
    await run('UserPromptSubmit', zz);
    const sql = fake.calls[idx(RENEW)].sql;
    expect(sql).not.toMatch(/project_key/);
    expect(sql).toMatch(/WHERE owner_session_id = \$1 AND state <> 'done'/);
    expect(fake.calls[idx(RENEW)].params).toEqual([ME]);
  });

  it('B3+B4: an unregistered cwd renews first, then reads direct messages only (one query, no board output)', async () => {
    const out = await run('UserPromptSubmit', nowhere);
    expect(out).toEqual({});
    const renew = idx(RENEW);
    expect(renew).toBeGreaterThan(-1);
    const reads = fake.calls.slice(renew + 1);
    expect(reads).toHaveLength(1);
    expect(reads[0].sql).toMatch(/FROM agentic_os\.lane_event/);
    expect(reads[0].params).toEqual([ME]);
  });

  it('B3+B4: a headless session renews, then returns {} with no read after it', async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
    const out = await run('SessionStart', ccv3);
    expect(out).toEqual({});
    expect(idx(RENEW)).toBeGreaterThan(-1);
    expect(fake.calls.length).toBe(idx(RENEW) + 1);
  });

  it('T6: a headless session in an unregistered cwd leaks no DM and reads nothing', async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
    fake.unread = [{ id: 31, occurred_at: '', lane_id: null, kind: 'say', session_id: 'bbbbbbbb-0000-4000-8000-000000000002', to_session_id: ME, body: 'secret dm', project_key: 'continuous-claude' }];
    const out = await run('UserPromptSubmit', nowhere);
    expect(out).toEqual({});
    expect(fake.calls.length).toBe(idx(RENEW) + 1);
    expect(fake.calls.some((c) => /lane_watermark/.test(c.sql) && /INSERT/.test(c.sql))).toBe(false);
  });

  describe('B3: an interactive session in an unregistered cwd still gets its direct messages', () => {
    const DM = { id: 31, occurred_at: '', lane_id: 'x-1', kind: 'say', session_id: 'bbbbbbbb-0000-4000-8000-000000000002', to_session_id: ME, body: 'stop editing foo.ts', project_key: 'continuous-claude' };

    it('UserPromptSubmit: injects the DM, no board header, and advances the sentinel row <id>@ (never the bare-id broadcast cursor)', async () => {
      fake.unread = [DM];
      const t = text(await run('UserPromptSubmit', nowhere));
      expect(t).toContain('stop editing foo.ts');
      expect(t).toContain('(direct to you)');
      expect(t).not.toContain('## Lane board');
      const w = fake.calls.find((c) => /INSERT INTO agentic_os\.lane_watermark/.test(c.sql));
      expect(w?.params).toEqual([`${ME}@`, 31]);
      expect(fake.calls.filter((c) => /INSERT INTO agentic_os.lane_watermark/.test(c.sql))).toHaveLength(1);
    });

    it('SessionStart: the DM arrives, with no banner, peers or claimable query', async () => {
      fake.unread = [DM];
      const t = text(await run('SessionStart', nowhere));
      expect(t).toContain('stop editing foo.ts');
      expect(t).not.toContain('## Lane board');
      expect(fake.calls.some((c) => /FROM sessions s/.test(c.sql))).toBe(false);
      expect(fake.calls.some((c) => /state IN \('ready','backlog'\)/.test(c.sql))).toBe(false);
    });

    it('reads only DMs on ONE cursor (MAX over the bare row and every <id>@<board> row), never broadcasts', async () => {
      await run('UserPromptSubmit', nowhere);
      const q = fake.calls.find((c) => /FROM agentic_os\.lane_event/.test(c.sql));
      expect(q?.sql).toContain('e.to_session_id = $1::text');
      expect(q?.sql).toContain('SELECT MAX(last_event_id) FROM agentic_os.lane_watermark');
      expect(q?.sql).toContain("session_id = $1::text OR starts_with(session_id, $1::text || '@')");
      expect(q?.sql).not.toMatch(/IS NULL/);
      expect(q?.params).toEqual([ME]);
    });

    it('no DM: no output and no watermark write', async () => {
      expect(await run('UserPromptSubmit', nowhere)).toEqual({});
      expect(fake.calls.some((c) => /INSERT INTO agentic_os\.lane_watermark/.test(c.sql))).toBe(false);
    });
  });

  it('LANE_CONTEXT_HEADLESS=1 opts a headless session back in', async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
    process.env.LANE_CONTEXT_HEADLESS = '1';
    expect(text(await run('SessionStart', ccv3))).toContain('## Lane board continuous-claude');
  });

  it('a payload with no cwd falls back to process.cwd() (no throw)', async () => {
    const out = await runLaneContext(JSON.stringify({ session_id: ME, hook_event_name: 'UserPromptSubmit' }));
    expect(typeof out).toBe('object');
  });
});

describe('B5-B6: unread events and the watermark', () => {
  const unreadSql = (): string => {
    const m = /const UNREAD_SQL = `([\s\S]*?)`;/.exec(SRC_LANE_MJS);
    expect(m, 'UNREAD_SQL not found in lane.mjs').not.toBeNull();
    return (m as RegExpExecArray)[1];
  };

  it('B5: the unread query contains lane.mjs UNREAD_SQL verbatim', async () => {
    await run('UserPromptSubmit', ccv3);
    const q = fake.calls.find((c) => /FROM agentic_os\.lane_event/.test(c.sql));
    expect(q, 'no unread query').toBeDefined();
    expect(q?.sql).toContain(unreadSql());
  });

  it('B5: params are [me, board, wmKey(me, board)] on the default board', async () => {
    await run('UserPromptSubmit', ccv3);
    const q = fake.calls.find((c) => /FROM agentic_os\.lane_event/.test(c.sql));
    expect(q?.params).toEqual([ME, 'continuous-claude', ME]);
  });

  it('B5+B6: on another board the cursor row is <id>@<board>', async () => {
    fake.unread = [{ id: 9, occurred_at: '', lane_id: null, kind: 'note', session_id: 'bbbbbbbb-0000-4000-8000-000000000002', to_session_id: null, body: 'hi', project_key: 'zz-board' }];
    const out = await run('UserPromptSubmit', zz);
    expect(text(out)).toContain('hi');
    const q = fake.calls.find((c) => /FROM agentic_os\.lane_event/.test(c.sql));
    expect(q?.params).toEqual([ME, 'zz-board', `${ME}@zz-board`]);
    const w = fake.calls.find((c) => /INSERT INTO agentic_os\.lane_watermark/.test(c.sql));
    expect(w?.params).toEqual([`${ME}@zz-board`, 9]);
  });

  it('B6: the default board still writes the bare id', async () => {
    fake.unread = [{ id: 4, occurred_at: '', lane_id: null, kind: 'note', session_id: 'bbbbbbbb-0000-4000-8000-000000000002', to_session_id: null, body: 'x', project_key: 'continuous-claude' }];
    await run('UserPromptSubmit', ccv3);
    const w = fake.calls.find((c) => /INSERT INTO agentic_os\.lane_watermark/.test(c.sql));
    expect(w?.params).toEqual([ME, 4]);
  });

  it('a DM that crossed boards is tagged [from <board>]; a same-board DM is not', async () => {
    fake.unread = [
      { id: 5, occurred_at: '', lane_id: null, kind: 'say', session_id: 'bbbbbbbb-0000-4000-8000-000000000002', to_session_id: ME, body: 'cross', project_key: 'continuous-claude' },
      { id: 6, occurred_at: '', lane_id: null, kind: 'say', session_id: 'bbbbbbbb-0000-4000-8000-000000000002', to_session_id: ME, body: 'same', project_key: 'zz-board' },
    ];
    const t = text(await run('UserPromptSubmit', zz));
    expect(t).toMatch(/\[from continuous-claude\][^\n]*cross/);
    expect(t).not.toMatch(/\[from zz-board\]/);
  });
});

describe('B7: the peer SQL is the lane.mjs peer SQL', () => {
  const HOOK_SRC = readFileSync(join(__dirname, '../lane-context.ts'), 'utf8');
  /** The three helpers: comments dropped, TS annotations dropped, whitespace folded. */
  const helpers = (src: string): string => {
    const a = src.indexOf('const FOLDED_PROJECT');
    const b = src.indexOf('const peerOfBoardSql');
    const end = src.indexOf('))`;', b) + 4;
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return src.slice(a, end).replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      .replace(/: string/g, '').replace(/\s+/g, ' ').trim();
  };
  it('FOLDED_PROJECT, underRootsSql and peerOfBoardSql match lane.mjs text', () => {
    expect(helpers(HOOK_SRC)).toBe(helpers(SRC_LANE_MJS));
  });
});

describe('B7-B10: SessionStart banner', () => {
  it('B7: claimable is filtered by project_key; peers by board roots', async () => {
    await run('SessionStart', zz);
    const claim = fake.calls.find((c) => /state IN \('ready','backlog'\)/.test(c.sql));
    expect(claim?.sql).toMatch(/project_key = \$1/);
    expect(claim?.params).toEqual(['zz-board']);
    const peers = fake.calls.find((c) => /FROM sessions s/.test(c.sql));
    expect(peers?.sql).toMatch(/starts_with\(/);
    expect(peers?.sql).not.toMatch(/\bLIKE\b/);
    expect(peers?.sql).toMatch(/bl\.project_key = \$3::text/);
    expect(peers?.params?.[0]).toBe(ME);
    expect(peers?.params?.[1]).toEqual([zz.replace(/\\/g, '/').toLowerCase()]);
    expect(peers?.params?.[2]).toBe('zz-board');
    expect(peers?.sql).toMatch(/l\.project_key = \$3/);
  });

  it('B8: "You hold" lists this board and summarises the rest', async () => {
    fake.mine = [
      { id: 'zz-1', title: 't', track: 'a', state: 'active', scope: null, note: null, owner_session_id: ME, lease_expires_at: null, project_key: 'zz-board', band: 'P1' },
      { id: 'zz-2', title: 't', track: 'a', state: 'active', scope: null, note: null, owner_session_id: ME, lease_expires_at: null, project_key: 'zz-board' },
      { id: 'ccv3-1', title: 't', track: 'a', state: 'active', scope: null, note: null, owner_session_id: ME, lease_expires_at: null, project_key: 'continuous-claude' },
      { id: 'ccv3-2', title: 't', track: 'a', state: 'active', scope: null, note: null, owner_session_id: ME, lease_expires_at: null, project_key: 'continuous-claude' },
    ];
    const t = text(await run('SessionStart', zz));
    // The band prints before each id; a lane with no band reads "--" (Unsorted).
    expect(t).toContain('You hold: P1 zz-1, -- zz-2');
    expect(t).toContain('+2 on other boards: ccv3-1@continuous-claude, ccv3-2@continuous-claude');
    expect(t).not.toMatch(/You hold:[^\n]*ccv3-1/);
  });

  it('B8: only other-board lanes still says "You hold no lane" for this board', async () => {
    fake.mine = [{ id: 'ccv3-1', title: 't', track: 'a', state: 'active', scope: null, note: null, owner_session_id: ME, lease_expires_at: null, project_key: 'continuous-claude' }];
    const t = text(await run('SessionStart', zz));
    expect(t).toContain('You hold no lane');
    expect(t).toContain('+1 on other boards: ccv3-1@continuous-claude');
  });

  it('B9: hints name the shim, never the relative path', async () => {
    const t = text(await run('SessionStart', ccv3));
    expect(t).toContain('node C:/Users/Tester/.claude/scripts/lane.mjs claim <id>');
    expect(t).not.toMatch(/node scripts\/coordination\/lane\.mjs/);
  });

  it('B10: the header names the board', async () => {
    expect(text(await run('SessionStart', zz))).toContain('## Lane board zz-board (concurrent sessions on this board)');
    expect(text(await run('SessionStart', ccv3))).toContain('## Lane board continuous-claude (concurrent sessions on this board)');
  });
});

describe('B11: a throttled error line instead of silence', () => {
  const log = (): string[] =>
    existsSync(process.env.LANE_CONTEXT_ERROR_LOG as string)
      ? readFileSync(process.env.LANE_CONTEXT_ERROR_LOG as string, 'utf8').split('\n').filter(Boolean) : [];
  afterEach(() => { try { rmSync(join(tmpdir(), `claude-lane-err-${ME}.json`), { force: true }); } catch { /* best effort */ } });

  it('a failing renew returns {} on stdout and appends one JSON line', async () => {
    rmSync(join(tmpdir(), `claude-lane-err-${ME}.json`), { force: true });
    fake.failOn = RENEW;
    expect(await run('UserPromptSubmit', ccv3)).toEqual({});
    const lines = log();
    expect(lines).toHaveLength(1);
    const j = JSON.parse(lines[0]);
    expect(j.session).toBe(ME);
    expect(j.error).toMatch(/boom/);
    expect(j.code).toBe('42501');
  });

  it('a second failure inside 10 minutes adds no line', async () => {
    rmSync(join(tmpdir(), `claude-lane-err-${ME}.json`), { force: true });
    fake.failOn = RENEW;
    await run('UserPromptSubmit', ccv3);
    await run('UserPromptSubmit', ccv3);
    await run('UserPromptSubmit', ccv3);
    expect(log()).toHaveLength(1);
  });

  it('a success writes no line', async () => {
    rmSync(join(tmpdir(), `claude-lane-err-${ME}.json`), { force: true });
    await run('UserPromptSubmit', ccv3);
    expect(log()).toHaveLength(0);
  });
});

describe('B12: the per-session resolver cache', () => {
  beforeEach(() => { process.env.LANE_BOARD_CACHE = '1'; });
  afterEach(() => { rmSync(join(tmpdir(), `claude-lane-board-${ME}.json`), { force: true }); });

  it('a cd to another board changes the board on the next call', async () => {
    rmSync(join(tmpdir(), `claude-lane-board-${ME}.json`), { force: true });
    expect(text(await run('SessionStart', ccv3))).toContain('## Lane board continuous-claude');
    expect(text(await run('SessionStart', zz))).toContain('## Lane board zz-board');
    expect(text(await run('SessionStart', ccv3))).toContain('## Lane board continuous-claude');
  });

  it('a cached board is reused for the same cwd (the registry is not read twice)', async () => {
    rmSync(join(tmpdir(), `claude-lane-board-${ME}.json`), { force: true });
    await run('SessionStart', zz);
    expect(existsSync(join(tmpdir(), `claude-lane-board-${ME}.json`))).toBe(true);
  });

  it('the cache never answers before the renew', async () => {
    rmSync(join(tmpdir(), `claude-lane-board-${ME}.json`), { force: true });
    await run('SessionStart', nowhere);
    fake.calls.length = 0;
    await run('SessionStart', nowhere);
    expect(idx(RENEW)).toBeGreaterThan(-1);
  });
});

describe('B13: the mid-turn DM cursor spans boards', () => {
  it('reads MAX over the bare row and every <id>@<board> row', async () => {
    const sid = `lc-board-dm-${process.pid}`;
    try { rmSync(dmStatePath(sid), { force: true }); } catch { /* none */ }
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await deliverDirectMessages(sid, Date.now(), vi.fn());
    const q = fake.calls.find((c) => /FROM agentic_os\.lane_event/.test(c.sql));
    expect(q?.sql).toMatch(/SELECT MAX\(last_event_id\)/);
    expect(q?.sql).toMatch(/session_id = \$1::text OR starts_with\(session_id, \$1::text \|\| '@'\)/);
    expect(q?.sql).toContain('e.to_session_id = $1');
    vi.restoreAllMocks();
    rmSync(dmStatePath(sid), { force: true });
  });
});

describe('B14: the SessionStart board line', () => {
  it('names the board for a registered folder', () => {
    expect(laneBoardLine(zz, process.env)).toBe('lane board: zz-board');
    expect(laneBoardLine(join(ccv3, 'sub'), process.env)).toBe('lane board: continuous-claude');
  });
  it('says "no lane board (unregistered dir)" for an unregistered folder', () => {
    expect(laneBoardLine(nowhere, process.env)).toBe('no lane board (unregistered dir)');
  });
  it('says nothing in a headless session', () => {
    expect(laneBoardLine(nowhere, { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })).toBe('');
  });
});

describe('B15: the adopt hint names the shim', () => {
  it('prints node <home>/.claude/scripts/lane.mjs adopt --from <uuid>', () => {
    const X = 'cccccccc-0000-4000-8000-0000000000aa';
    writeIdentity(X, { name: 'foo', cwd: 'C:/work/repo', endedAt: null });
    const line = sameNameHint('dddddddd-0000-4000-8000-0000000000bb', 'foo', 'C:/work/repo');
    expect(line).toContain(`node C:/Users/Tester/.claude/scripts/lane.mjs adopt --from ${X}`);
    expect(line).not.toContain('scripts/coordination/lane.mjs');
  });
});
