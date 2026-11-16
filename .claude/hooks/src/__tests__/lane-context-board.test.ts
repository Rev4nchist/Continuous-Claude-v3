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
  /** The Related lookup: lane rows (id, owner_session_id). The fake returns the rows whose id is in the query array. */
  lanes: [] as Array<{ id: string; owner_session_id: string | null; reclaimable?: boolean }>,
  failOn: null as RegExp | null,
  /** P15: the watermark INSERT settles this many ms late, and records that it did. */
  insertDelayMs: 0,
  insertSettled: false,
}));

vi.mock('pg', () => {
  class Client {
    on(): this { return this; }
    async connect(): Promise<void> { /* connected */ }
    async end(): Promise<void> { /* closed */ }
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      fake.calls.push({ sql, params });
      if (fake.failOn && fake.failOn.test(sql)) throw Object.assign(new Error('boom: ' + sql.slice(0, 30)), { code: '42501' });
      if (/INSERT INTO agentic_os\.lane_watermark/.test(sql) && fake.insertDelayMs) {
        await new Promise((res) => setTimeout(res, fake.insertDelayMs));
        fake.insertSettled = true;
      }
      if (/FROM agentic_os\.lane WHERE id = ANY/.test(sql)) {
        const want = (params?.[0] ?? []) as string[];
        return { rows: fake.lanes.filter((l) => want.includes(l.id)) };
      }
      if (/FROM sessions s/.test(sql)) return { rows: [{ sid: 'bbbbbbbb-0000-4000-8000-000000000002', lanes: 'zz-1', scopes: 'src', total: 1 }] };
      if (/FROM agentic_os\.lane_event e\b/.test(sql)) return { rows: fake.unread };
      if (/state IN \('ready','backlog'\)/.test(sql)) return { rows: fake.claimable };
      if (/WHERE owner_session_id=\$1 AND state<>'done'/.test(sql)) return { rows: fake.mine };
      return { rows: [] };
    }
  }
  return { Client, default: { Client } };
});

import { runLaneContext, deliverDirectMessages, dmStatePath, pageUnread, parseRelatesTo } from '../lane-context.js';
import { writeIdentity } from '../shared/session-identity.js';
import { laneBoardLine, sameNameHint } from '../shared/session-names.js';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const PEER_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
/** What laneCliCmd() prints under CCV3_USER_HOME=C:/Users/Tester. */
const SHIM = 'node C:/Users/Tester/.claude/scripts/lane.mjs';
/** The reply footer, one shared text for the prompt path and the mid-turn path (M4.14). */
const REPLY_FOOTER = 'A DM with a decision, a finding or a request: reply one time (M4.14).';
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
  fake.calls.length = 0; fake.mine = []; fake.claimable = []; fake.unread = []; fake.lanes = []; fake.failOn = null;
  fake.insertDelayMs = 0; fake.insertSettled = false;
  // C10 (coord-banner-page-budget): no cursor write past 3.0 s of process uptime. The worker is older than a hook.
  vi.spyOn(process, 'uptime').mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
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

  it('B5: the renew keeps the later lease (GREATEST), so a parked lane keeps its park lease', async () => {
    await run('UserPromptSubmit', ccv3);
    const sql = fake.calls[idx(RENEW)].sql;
    expect(sql).toMatch(/SET lease_expires_at = GREATEST\(lease_expires_at, now\(\) \+ interval '90 minutes'\)/);
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
    // board_wm 5: a WARM board (a cursor row exists). Without it the read takes the cold branch.
    fake.unread = [{ id: 9, occurred_at: '', lane_id: null, kind: 'note', session_id: 'bbbbbbbb-0000-4000-8000-000000000002', to_session_id: null, body: 'hi', project_key: 'zz-board', board_wm: 5 }];
    const out = await run('UserPromptSubmit', zz);
    expect(text(out)).toContain('hi');
    const q = fake.calls.find((c) => /FROM agentic_os\.lane_event/.test(c.sql));
    expect(q?.params).toEqual([ME, 'zz-board', `${ME}@zz-board`]);
    const w = fake.calls.find((c) => /INSERT INTO agentic_os\.lane_watermark/.test(c.sql));
    expect(w?.params).toEqual([`${ME}@zz-board`, 9]);
  });

  it('B6: the default board still writes the bare id', async () => {
    fake.unread = [{ id: 4, occurred_at: '', lane_id: null, kind: 'note', session_id: 'bbbbbbbb-0000-4000-8000-000000000002', to_session_id: null, body: 'x', project_key: 'continuous-claude', board_wm: 1 }];
    await run('UserPromptSubmit', ccv3);
    const w = fake.calls.find((c) => /INSERT INTO agentic_os\.lane_watermark/.test(c.sql));
    expect(w?.params).toEqual([ME, 4]);
  });

  it('a DM that crossed boards is tagged [from <board>]; a same-board DM is not', async () => {
    fake.unread = [
      { id: 5, occurred_at: '', lane_id: null, kind: 'say', session_id: 'bbbbbbbb-0000-4000-8000-000000000002', to_session_id: ME, body: 'cross', project_key: 'continuous-claude', board_wm: 1 },
      { id: 6, occurred_at: '', lane_id: null, kind: 'say', session_id: 'bbbbbbbb-0000-4000-8000-000000000002', to_session_id: ME, body: 'same', project_key: 'zz-board', board_wm: 1 },
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

  it('B9: every lane command in the three no-lane lines uses the shim path, never a relative path', async () => {
    const t = text(await run('SessionStart', ccv3));
    const lines = t.split('\n');
    const at = lines.findIndex((l) => l.startsWith('You hold no lane.'));
    expect(at, 'no "You hold no lane" line').toBeGreaterThan(-1);
    const block = lines.slice(at, at + 3).join('\n');
    const paths = [...block.matchAll(/\S*lane\.mjs/g)].map((m) => m[0]);
    // L1 has mine and board; L2 has add and board --all: four commands.
    expect(paths.length).toBeGreaterThanOrEqual(4);
    for (const p of paths) expect(p).toBe('C:/Users/Tester/.claude/scripts/lane.mjs');
    expect(block).toContain(`${SHIM} mine`);
    expect(block).toContain(`${SHIM} board --by priority`);
    expect(block).toContain(`${SHIM} add <new-id>`);
    expect(block).toContain(`${SHIM} board --all`);
    expect(t).not.toMatch(/node scripts\/coordination\/lane\.mjs/);
  });

  it('B10: the header names the board', async () => {
    expect(text(await run('SessionStart', zz))).toContain('## Lane board zz-board (concurrent sessions on this board)');
    expect(text(await run('SessionStart', ccv3))).toContain('## Lane board continuous-claude (concurrent sessions on this board)');
  });
});

describe('E1: the no-lane lines and the Milestone line', () => {
  const L1 = `You hold no lane. 1. kanban-sync when the board has a phone page. 2. ${SHIM} mine. 3. ${SHIM} board --by priority, then claim the lane for your work by id.`;
  const L2 = `No lane for it: ${SHIM} add <new-id> --title "..." --scope "..." only when ${SHIM} board --all shows the id in no state, then claim it. Never run add on an existing lane that you do not hold.`;
  const L3 = 'Rules: lane-board.md. Rule ids: docs/coordination/standard.md.';
  const MILESTONE = 'Milestone (start, commit, decision by Dave, finding, block, done): send one DM to each holder in your RELATES TO list (M4.11).';
  const held = (id: string, scope: string | null, project_key = 'continuous-claude'): Record<string, unknown> =>
    ({ id, title: 't', track: 'a', state: 'active', scope, note: null, owner_session_id: ME, lease_expires_at: null, project_key, band: 'P1' });

  it('E1: a session with no lane gets L1, L2 and L3, in that order, and no Milestone line', async () => {
    const t = text(await run('SessionStart', ccv3));
    const lines = t.split('\n');
    const at = lines.indexOf(L1);
    expect(at, 'L1 not found as a whole line').toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe(L2);
    expect(lines[at + 2]).toBe(L3);
    expect(t).not.toContain('Milestone');
    expect(t).not.toContain('Claim one by id before starting work');
    expect(lines.slice(at, at + 3).join('\n')).not.toContain('\u2014');
  });

  it('E1: a session that holds a lane gets the Milestone line directly after the "You hold:" line', async () => {
    fake.mine = [held('c-1', null)];
    const t = text(await run('SessionStart', ccv3));
    const lines = t.split('\n');
    const at = lines.findIndex((l) => l.startsWith('You hold:'));
    expect(lines[at]).toBe('You hold: P1 c-1');
    expect(lines[at + 1]).toBe(MILESTONE);
    expect(t).not.toContain('You hold no lane');
    expect(t).not.toContain(L3);
  });

  it('E1: a session that holds a lane only on another board gets no Milestone line (it holds none on this board)', async () => {
    fake.mine = [held('ccv3-1', null, 'continuous-claude')];
    const t = text(await run('SessionStart', zz));
    expect(t).toContain('You hold no lane');
    expect(t).not.toContain('Milestone');
  });
});

describe('E3: parseRelatesTo', () => {
  it('takes the ids that come last in the scope text', () => {
    expect(parseRelatesTo('keep out of src/. RELATES TO: a-1, b-2')).toEqual(['a-1', 'b-2']);
  });
  it('splits on commas and on white space', () => {
    expect(parseRelatesTo('RELATES TO: a-1 b-2,c.3,   d-4')).toEqual(['a-1', 'b-2', 'c.3', 'd-4']);
  });
  it('strips a trailing full stop from an id', () => {
    expect(parseRelatesTo('RELATES TO: a-1, b-2.')).toEqual(['a-1', 'b-2']);
  });
  it('uses the text after the LAST "RELATES TO:"', () => {
    expect(parseRelatesTo('RELATES TO: old-1 | other text | RELATES TO: new-1, new-2')).toEqual(['new-1', 'new-2']);
  });
  it('removes duplicates and keeps the order of first use', () => {
    expect(parseRelatesTo('RELATES TO: b-2, a-1, b-2, a-1')).toEqual(['b-2', 'a-1']);
  });
  it('drops a token that has a character outside [A-Za-z0-9._-]', () => {
    expect(parseRelatesTo('RELATES TO: a-1, b/2, (c-3)')).toEqual(['a-1']);
  });
  it('gives [] with no "RELATES TO:", for null and for undefined', () => {
    expect(parseRelatesTo('only scope text, a-1')).toEqual([]);
    expect(parseRelatesTo(null)).toEqual([]);
    expect(parseRelatesTo(undefined)).toEqual([]);
    expect(parseRelatesTo('')).toEqual([]);
  });
});

describe('E3: the Related line in the SessionStart banner', () => {
  const held = (id: string, scope: string | null, project_key = 'continuous-claude'): Record<string, unknown> =>
    ({ id, title: 't', track: 'a', state: 'active', scope, note: null, owner_session_id: ME, lease_expires_at: null, project_key, band: 'P1' });
  const lookups = (): Array<{ sql: string; params: unknown[] | undefined }> =>
    fake.calls.filter((c) => /FROM agentic_os\.lane WHERE id = ANY/.test(c.sql));
  const errLog = (): string => process.env.LANE_CONTEXT_ERROR_LOG as string;
  const stamp = (): string => join(tmpdir(), `claude-lane-err-${ME}.json`);
  beforeEach(() => { rmSync(stamp(), { force: true }); });
  afterEach(() => { rmSync(stamp(), { force: true }); });

  it('E3: owner gives who(owner), a null owner gives "no holder", a missing row gives "no such lane"; the line follows Milestone', async () => {
    writeIdentity(PEER_ID, { name: 'trex', cwd: 'C:/work/repo', endedAt: null });
    fake.mine = [held('c-1', 'src only. RELATES TO: peer-1, none-1, ghost-9')];
    fake.lanes = [{ id: 'peer-1', owner_session_id: PEER_ID, reclaimable: false }, { id: 'none-1', owner_session_id: null, reclaimable: false }];
    const t = text(await run('SessionStart', ccv3));
    const lines = t.split('\n');
    const at = lines.findIndex((l) => l.startsWith('Milestone'));
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe('Related: peer-1 (trex #bbbbbbbb), none-1 (no holder), ghost-9 (no such lane)');
    expect(lookups()).toHaveLength(1);
    expect(lookups()[0].params).toEqual([['peer-1', 'none-1', 'ghost-9']]);
    const sql = lookups()[0].sql.replace(/\s+/g, ' ').trim();
    expect(sql).toMatch(/^SELECT id, owner_session_id, .+ AS reclaimable FROM agentic_os\.lane WHERE id = ANY\(\$1::text\[\]\)$/);
    // The reclaim test of rule L2.8, the same as lane.mjs: the lease ended AND the holder is quiet for 5 minutes.
    expect(sql).toContain('lease_expires_at IS NULL OR lease_expires_at < now()');
    expect(sql).toContain("GREATEST(s.last_heartbeat, s.last_activity_at) > now() - interval '5 minutes'");
  });

  it('E3: a lane whose holder is quiet and whose lease ended prints "reclaimable", not the old holder (M4.12: no DM)', async () => {
    writeIdentity(PEER_ID, { name: 'trex', cwd: 'C:/work/repo', endedAt: null });
    fake.mine = [held('c-1', 'RELATES TO: gone-1, live-1')];
    fake.lanes = [{ id: 'gone-1', owner_session_id: PEER_ID, reclaimable: true }, { id: 'live-1', owner_session_id: PEER_ID, reclaimable: false }];
    const t = text(await run('SessionStart', ccv3));
    expect(t).toContain('Related: gone-1 (reclaimable), live-1 (trex #bbbbbbbb)');
  });

  it('E3: the ids of every lane held on this board are used; an id of a lane the session holds is dropped; no repeats', async () => {
    fake.mine = [
      held('c-1', 'RELATES TO: a-1, c-2, b-2'),
      held('c-2', 'RELATES TO: b-2, c-1, a-1'),
      held('other-1', 'RELATES TO: elsewhere-9', 'zz-board'),
    ];
    fake.lanes = [{ id: 'a-1', owner_session_id: null }, { id: 'b-2', owner_session_id: null }];
    const t = text(await run('SessionStart', ccv3));
    expect(t).toContain('Related: a-1 (no holder), b-2 (no holder)');
    expect(t).not.toMatch(/Related:[^\n]*(c-1|c-2|elsewhere-9)/);
    expect(lookups()[0].params).toEqual([['a-1', 'b-2']]);
  });

  it('E3: an id of a lane the session holds on another board is dropped too (lane ids are global)', async () => {
    fake.mine = [
      held('c-1', 'RELATES TO: a-1, other-1'),
      held('other-1', null, 'zz-board'),
    ];
    fake.lanes = [{ id: 'a-1', owner_session_id: null }, { id: 'other-1', owner_session_id: ME }];
    const t = text(await run('SessionStart', ccv3));
    expect(t).toContain('Related: a-1 (no holder)');
    expect(t).not.toMatch(/Related:[^\n]*other-1/);
    expect(lookups()[0].params).toEqual([['a-1']]);
  });

  it('E3: no RELATES TO in any scope prints no Related line', async () => {
    fake.mine = [held('c-1', 'src only'), held('c-2', null)];
    const t = text(await run('SessionStart', ccv3));
    expect(t).toContain('Milestone');
    expect(t).not.toContain('Related:');
  });

  it('E3: a session with no lane prints no Related line', async () => {
    fake.lanes = [{ id: 'a-1', owner_session_id: null }];
    expect(text(await run('SessionStart', ccv3))).not.toContain('Related:');
  });

  it('E3: at most 8 ids show, then ", +N more"', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `r-${i + 1}`);
    fake.mine = [held('c-1', `RELATES TO: ${ids.join(', ')}`)];
    fake.lanes = ids.map((id) => ({ id, owner_session_id: null }));
    const line = text(await run('SessionStart', ccv3)).split('\n').find((l) => l.startsWith('Related:')) ?? '';
    expect(line).toBe(`Related: ${ids.slice(0, 8).map((id) => `${id} (no holder)`).join(', ')}, +2 more`);
    expect(line).not.toContain('r-9');
  });

  it('E3: a failing lookup keeps the banner, drops the Related line and logs one line', async () => {
    fake.mine = [held('c-1', 'RELATES TO: peer-1')];
    fake.lanes = [{ id: 'peer-1', owner_session_id: PEER_ID }];
    fake.failOn = /FROM agentic_os\.lane WHERE id = ANY/;
    const t = text(await run('SessionStart', ccv3));
    expect(t).toContain('## Lane board continuous-claude');
    expect(t).toContain('You hold: P1 c-1');
    expect(t).toContain('Commands:');
    expect(t).not.toContain('Related:');
    expect(existsSync(errLog()), 'no error line logged').toBe(true);
    const lines = readFileSync(errLog(), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).error).toMatch(/boom/);
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
  it('gives the two-line text for an unregistered folder: the board command, then the register rule', () => {
    expect(laneBoardLine(nowhere, process.env)).toBe(
      `no lane board (unregistered dir). Work for a board: ${SHIM} board --project <key>. Else run no lane command.\nRegister a folder only with Dave's yes.`,
    );
  });
  it('takes the shim path from the env it was given, the same env that resolves the board', () => {
    expect(laneBoardLine(nowhere, { ...process.env, CCV3_USER_HOME: 'C:/Users/Other' })).toContain(
      'Work for a board: node C:/Users/Other/.claude/scripts/lane.mjs board --project <key>.',
    );
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

/**
 * The banner cursor (coord-banner-cursor). Failure list, one case each. Ids P1.. are new; B ids above are old.
 *   F1  an event after the 12th is marked read and never shown
 *   F2  a DM behind 12 or more broadcasts is not on page 1
 *   F3  an event is shown twice, or a cut event is covered by a written cursor
 *   F4  the board row passes a cut DM
 *   F5  a cold start pages from event 1, or drops a DM
 *   F6  the sentinel is written when nothing is cut, or when it is not above the board row
 *   F7  two statements, or a write that is not awaited
 *   F8  the no-board path keeps the old newest-12 slice
 *   F9  the "more" line is missing, has a wrong count, or prints a relative lane.mjs
 *   B2/B3/B4 of the note: cold skipped events count as shown for the cursor; the no-board sentinel; the header count
 *   C3  ids from pg are strings and must not be compared or sorted as strings
 * P1 to P15 run the real runLaneContext on the stub client. U1 to U7 run the real pageUnread. The paging SQL runs
 * for real in lane-context-db.test.ts (D6 and up).
 */
describe('P: the banner pages unread events without losing any', () => {
  const PEER = 'bbbbbbbb-0000-4000-8000-000000000002';
  const SENT = `${ME}@`;
  const MORE_CMD = 'node C:/Users/Tester/.claude/scripts/lane.mjs inbox)';
  type Row = Record<string, unknown>;
  /** One unread row. wm is the board_wm column: a number or string for a warm board, null for a cold one. */
  const ev = (id: number | string, tag: string, o: { dm?: boolean; wm?: number | string | null } = {}): Row => ({
    id, occurred_at: '', lane_id: null, kind: 'note', session_id: PEER, to_session_id: o.dm ? ME : null,
    body: `<${tag}>`, project_key: 'continuous-claude', board_wm: o.wm === undefined ? 100 : o.wm,
  });
  const bcs = (from: number, to: number, wm: number | null = 100): Row[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ev(from + i, `bc${from + i}`, { wm }));
  const dms = (from: number, to: number, wm: number | null = 100): Row[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ev(from + i, `dm${from + i}`, { dm: true, wm }));
  const tags = (t: string): string[] => [...t.matchAll(/<(\w+)>/g)].map((m) => m[1]);
  const seq = (prefix: string, from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
  const inserts = (): Array<{ sql: string; params: unknown[] | undefined }> =>
    fake.calls.filter((c) => /INSERT INTO agentic_os\.lane_watermark/.test(c.sql));

  it('P1 (F1): 14 broadcasts show the OLDEST 12, in id order, and the row stops at the last one shown', async () => {
    fake.unread = bcs(101, 114);
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(tags(t)).toEqual(seq('bc', 101, 112));
    expect(t).toContain('## 14 lane update(s) since you last looked');
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toEqual([ME, 112]);
  });

  it('P2 (F2, F7): a DM behind 13 broadcasts is on page 1; one statement writes the board row and the sentinel', async () => {
    fake.unread = [...bcs(101, 113), ...dms(114, 114)];
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(tags(t)).toEqual([...seq('bc', 101, 111), 'dm114']);
    expect(t).toMatch(/\(direct to you\): <dm114>/);
    expect(t).toContain('## 14 lane update(s) since you last looked');
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toEqual([ME, 111, SENT, 114]);
    expect(inserts()[0].sql).toMatch(/^\s*INSERT INTO agentic_os\.lane_watermark AS w/);
    expect(inserts()[0].sql).toContain('GREATEST(w.last_event_id, EXCLUDED.last_event_id)');
  });

  it('P3 (F4, extra 3): 13 DMs above 5 broadcasts: no broadcast on page 1, and the row stays below the lowest broadcast', async () => {
    fake.unread = [...bcs(101, 105), ...dms(106, 118)];
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(tags(t)).toEqual(seq('dm', 106, 117));
    expect(t).toContain('## 18 lane update(s) since you last looked');
    expect(t).toContain('(6 more unread, 1 direct to you.');
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toEqual([ME, 100, SENT, 117]);
  });

  it('P4 (F4): 13 DMs and no broadcast: the row is one below the cut DM, so the 13th DM stays unread', async () => {
    fake.unread = dms(101, 113);
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(tags(t)).toEqual(seq('dm', 101, 112));
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toEqual([ME, 112]);
  });

  it('P5 (F5, B1): a cold start with 30 broadcasts shows the newest 12 and says 18 were not shown, with no command', async () => {
    fake.unread = bcs(101, 130, null);
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(tags(t)).toEqual(seq('bc', 119, 130));
    expect(t).toContain('## 12 lane update(s) since you last looked');
    expect(t).toContain('(18 older board events are not shown on your first look at this board.)');
    expect(t).not.toMatch(/more unread/);
    expect(inserts()[0].params).toEqual([ME, 130]);
  });

  it('P6 (B2, B4, F9): cold, 20 broadcasts and 3 DMs: 3 DMs and 9 of the newest 12; header counts shown + cut, not the 8 skipped', async () => {
    fake.unread = [...bcs(201, 220, null), ...dms(221, 223, null)];
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(tags(t)).toEqual([...seq('bc', 209, 217), 'dm221', 'dm222', 'dm223']);
    expect(t).toContain('## 15 lane update(s) since you last looked');
    // C9: this cold page WRITES the board row (217), so `inbox` reads from it after the page: the line names it.
    expect(t).toContain(`(3 more unread. Later prompts show them, oldest first, or run: ${MORE_CMD}`);
    expect(t).toContain('(8 older board events are not shown on your first look at this board.)');
    expect(inserts()[0].params).toEqual([ME, 217, SENT, 223]);
  });

  it('P7 (C2, F5): cold with a cut DM writes ONLY the sentinel, so the next prompt is cold again', async () => {
    fake.unread = [...bcs(201, 220, null), ...dms(221, 233, null)];
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(tags(t)).toEqual(seq('dm', 221, 232));
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toEqual([SENT, 232]);
    // Row 46: a cold page that cuts a DM and 12 board events. The board events show later only while they stay in the newest 12.
    // Card coord-banner-dm-never-cut (G2): a waiting DM on a board always names the inbox command, with no board row too.
    expect(t).toContain('  (13 more unread, 1 direct to you. Later prompts show the direct ones, oldest first, or run: node C:/Users/Tester/.claude/scripts/lane.mjs inbox. The board events show only while they are among the newest 12 of this board.)');
    // No board row is written, so the cold line waits for the page that writes it.
    expect(t).not.toMatch(/not shown on your first look/);
  });

  it('P8 (F8, B3): no board, 13 DMs: the OLDEST 12 now, the sentinel on the 12th, the 13th on the next prompt', async () => {
    fake.unread = dms(101, 113);
    const t = text(await run('UserPromptSubmit', nowhere));
    expect(tags(t)).toEqual(seq('dm', 101, 112));
    expect(t).toContain('## 13 lane update(s) since you last looked');
    // `inbox` needs a board, and this folder has none: the line names no command.
    expect(t).toContain('(1 more unread, 1 direct to you. Later prompts show them, oldest first.)');
    expect(t).not.toMatch(/inbox/);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toEqual([SENT, 112]);
    fake.calls.length = 0;
    fake.unread = dms(113, 113);
    expect(tags(text(await run('UserPromptSubmit', nowhere)))).toEqual(['dm113']);
    expect(inserts()[0].params).toEqual([SENT, 113]);
  });

  it('P9 (F9): the "more" line names the shim, counts the cut, and prints no em dash or "suppressed"', async () => {
    fake.unread = bcs(101, 114);
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(t).toContain(`(2 more unread. Later prompts show them, oldest first, or run: ${MORE_CMD}`);
    expect(t).not.toMatch(/suppressed/);
    expect(t).not.toContain('\u2014');
    expect(t).not.toMatch(/node scripts\/coordination\/lane\.mjs/);
  });

  it('P10 (F6): nothing cut, DM among broadcasts: one row [key, newest id], no sentinel row, no "more" line', async () => {
    fake.unread = [...bcs(101, 102), ...dms(103, 103), ...bcs(104, 104)];
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(tags(t)).toEqual(['bc101', 'bc102', 'dm103', 'bc104']);
    expect(t).not.toMatch(/more unread/);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toEqual([ME, 104]);
    // The code before the change also passes the lines above. The next line is the new write contract.
    expect(inserts()[0].sql).toContain('GREATEST(w.last_event_id, EXCLUDED.last_event_id)');
  });

  it('P11 (C3, extra 2): string ids from pg, no board: 13 DMs 95..107 give 95..106 and a NUMERIC sentinel 106', async () => {
    fake.unread = Array.from({ length: 13 }, (_, i) => ev(String(95 + i), `dm${95 + i}`, { dm: true }));
    const t = text(await run('UserPromptSubmit', nowhere));
    expect(tags(t)).toEqual(seq('dm', 95, 106));
    expect(inserts()[0].params).toEqual([SENT, 106]);
  });

  it('P12 (C3): string ids on a board, a DM behind a cut: the DM sentinel is the NUMBER 108, not the string "108"', async () => {
    // 13 broadcasts "95".."107" (the ids cross 99 -> 100) and a DM "108". The DM shows, 11 broadcasts show, 2 are cut.
    // The board row is one below the first cut broadcast (a number, from the minus). Only the sentinel carries the DM's
    // own id, so only it shows whether readUnread converted the id: remove the Number() there and it is the string "108".
    fake.unread = [
      ...Array.from({ length: 13 }, (_, i) => ev(String(95 + i), `bc${95 + i}`, { wm: '94' as unknown as number })),
      ev('108', 'dm108', { dm: true, wm: '94' as unknown as number }),
    ];
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(tags(t)).toEqual([...seq('bc', 95, 105), 'dm108']);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toEqual([ME, 105, SENT, 108]);
  });

  it('P12b (C3): string ids, nothing cut: "99" is not above "100", so no sentinel row is written', async () => {
    fake.unread = [ev('98', 'bc98', { wm: '94' }), ev('99', 'dm99', { dm: true, wm: '94' }), ev('100', 'bc100', { wm: '94' })];
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(tags(t)).toEqual(['bc98', 'dm99', 'bc100']);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toEqual([ME, 100]);
  });

  it('P16 (C1): the unread read is ONE statement that carries the board row, so the cold test has one snapshot', async () => {
    fake.unread = bcs(101, 102);
    await run('UserPromptSubmit', ccv3);
    const reads = fake.calls.filter((c) => /lane_event/.test(c.sql));
    expect(reads).toHaveLength(1);
    expect(reads[0].sql).toContain('board_wm');
    expect(reads[0].params).toEqual([ME, 'continuous-claude', ME]);
  });

  it('P17 (C6b, extra 1): the cold line prints once, on the page that writes the board row', async () => {
    const cold = (rows: Row[]): Row[] => rows.map((r) => ({ ...r, board_wm: null }));
    const lineRe = /\(75 older board events are not shown on your first look at this board\.\)/;
    // Page 1: a cut DM, so only the sentinel is written. No cold line yet.
    fake.unread = cold([...bcs(1, 49), ...dms(50, 62), ...bcs(63, 100)]);
    const p1 = text(await run('UserPromptSubmit', ccv3));
    expect(tags(p1)).toEqual(seq('dm', 50, 61));
    expect(p1).not.toMatch(/not shown on your first look/);
    expect(inserts()[0].params).toEqual([SENT, 61]);
    // Page 2: still cold, the board row is written, the cold line prints.
    fake.calls.length = 0;
    fake.unread = cold([...bcs(1, 49), ...dms(62, 62), ...bcs(63, 100)]);
    const p2 = text(await run('UserPromptSubmit', ccv3));
    expect(tags(p2)).toEqual(['dm62', ...seq('bc', 89, 99)]);
    expect(p2).toMatch(lineRe);
    expect(inserts()[0].params).toEqual([ME, 99]);
    // Page 3: warm, no cold line.
    fake.calls.length = 0;
    fake.unread = bcs(100, 100, 99);
    const p3 = text(await run('UserPromptSubmit', ccv3));
    expect(tags(p3)).toEqual(['bc100']);
    expect(p3).not.toMatch(/not shown on your first look/);
  });

  it('P13 (F1, extra 4): 30 broadcasts page as 12, 12, 6 with the right counts', async () => {
    fake.unread = bcs(101, 130, 100);
    const p1 = text(await run('UserPromptSubmit', ccv3));
    expect(tags(p1)).toEqual(seq('bc', 101, 112));
    expect(p1).toContain('(18 more unread. Later prompts show them');
    expect(inserts()[0].params).toEqual([ME, 112]);
    fake.calls.length = 0;
    fake.unread = bcs(113, 130, 112);
    const p2 = text(await run('UserPromptSubmit', ccv3));
    expect(tags(p2)).toEqual(seq('bc', 113, 124));
    expect(p2).toContain('(6 more unread. Later prompts show them');
    expect(inserts()[0].params).toEqual([ME, 124]);
    fake.calls.length = 0;
    fake.unread = bcs(125, 130, 124);
    const p3 = text(await run('UserPromptSubmit', ccv3));
    expect(tags(p3)).toEqual(seq('bc', 125, 130));
    expect(p3).not.toMatch(/more unread/);
    expect(inserts()[0].params).toEqual([ME, 130]);
  });

  it('P14 (extra 6): cold with 12 broadcasts and a DM: no "not shown" line, because nothing was skipped', async () => {
    fake.unread = [...bcs(201, 212, null), ...dms(213, 213, null)];
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(t).not.toMatch(/not shown on your first look/);
    expect(tags(t)).toEqual([...seq('bc', 201, 211), 'dm213']);
    // C9: the page writes the board row (211), so the line names `inbox`.
    expect(t).toContain(`(1 more unread. Later prompts show them, oldest first, or run: ${MORE_CMD}`);
    expect(inserts()[0].params).toEqual([ME, 211, SENT, 213]);
  });

  it('P15 (F7, extra 7): the two-row write is ONE statement and it settles before runLaneContext returns', async () => {
    fake.unread = [...bcs(101, 113), ...dms(114, 114)];
    fake.insertDelayMs = 60;
    const out = await run('UserPromptSubmit', ccv3);
    expect(fake.insertSettled, 'the write was not awaited').toBe(true);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toEqual([ME, 111, SENT, 114]);
    expect(text(out)).toContain('<dm114>');
  });

  const COLD_CUT_LINE = (cut: number, cutDm: number): string =>
    `  (${cut} more unread, ${cutDm} direct to you. Later prompts show the direct ones, oldest first, or run: node C:/Users/Tester/.claude/scripts/lane.mjs inbox. The board events show only while they are among the newest 12 of this board.)`;

  it('P18 (row 46): cold board page, 13 DMs and 3 broadcasts: the cut DM and the cut broadcasts get the new line, with the inbox command (G2)', async () => {
    fake.unread = [...bcs(201, 203, null), ...dms(211, 223, null)];
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(tags(t)).toEqual(seq('dm', 211, 222));
    // 1 cut DM + 3 broadcasts that wait behind it.
    expect(t.split('\n')).toContain(COLD_CUT_LINE(4, 1));
    expect(t).not.toContain(String.fromCharCode(0x2014));
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toEqual([SENT, 222]);
  });

  it('P18b (row 46): cold board page that cuts only a DM (no board event is cut) keeps today\'s line, and names the inbox command (G2)', async () => {
    fake.unread = dms(101, 113, null);
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(t).toContain(`  (1 more unread, 1 direct to you. Later prompts show them, oldest first, or run: ${MORE_CMD}`);
    expect(t).not.toMatch(/newest 12/);
  });

  it('P18c (row 46): a WARM board page that cuts a DM and broadcasts keeps today\'s line, with the inbox command', async () => {
    fake.unread = [...bcs(101, 105), ...dms(106, 118)];
    const t = text(await run('UserPromptSubmit', ccv3));
    expect(t).toContain(`  (6 more unread, 1 direct to you. Later prompts show them, oldest first, or run: ${MORE_CMD}`);
    expect(t).not.toMatch(/newest 12/);
  });

  it('P19 (F1): SessionStart pages too: 14 broadcasts show the oldest 12 under the banner, and the row stops at the 12th', async () => {
    fake.unread = bcs(101, 114);
    const t = text(await run('SessionStart', ccv3));
    expect(t).toContain('## Lane board continuous-claude');
    // The banner text holds tags like <id>: keep only this file's event tags.
    expect(tags(t).filter((x) => /^(bc|dm)\d+$/.test(x))).toEqual(seq('bc', 101, 112));
    expect(t).toContain('## 14 lane update(s) since you last looked');
    expect(t).toContain('(2 more unread. Later prompts show them');
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toEqual([ME, 112]);
  });

  describe('E4: the reply footer on the prompt, SessionStart and no-board paths', () => {
    const lastLine = (t: string): string => t.split('\n').slice(-1)[0];
    const count = (t: string): number => t.split(REPLY_FOOTER).length - 1;

    it('F1: a page with direct messages ends with the footer, one time, however many DMs it shows', async () => {
      fake.unread = [...bcs(101, 102), ...dms(103, 104)];
      const t = text(await run('UserPromptSubmit', ccv3));
      expect(lastLine(t)).toBe(REPLY_FOOTER);
      expect(count(t)).toBe(1);
    });

    it('F2: the footer is the LAST line, after the "more" line and the cold line', async () => {
      fake.unread = [...bcs(201, 220, null), ...dms(221, 223, null)];
      const t = text(await run('UserPromptSubmit', ccv3));
      expect(t).toContain('(3 more unread.');
      expect(t).toContain('(8 older board events are not shown on your first look at this board.)');
      expect(lastLine(t)).toBe(REPLY_FOOTER);
      expect(count(t)).toBe(1);
    });

    it('F3: a page with only board events has no footer', async () => {
      fake.unread = bcs(101, 114);
      const t = text(await run('UserPromptSubmit', ccv3));
      expect(t).toContain('(2 more unread.');
      expect(t).not.toContain(REPLY_FOOTER);
      expect(t).not.toContain('reply one time');
    });

    it('F4: a session with no board gets the footer after its direct messages', async () => {
      fake.unread = dms(101, 102);
      const t = text(await run('UserPromptSubmit', nowhere));
      expect(lastLine(t)).toBe(REPLY_FOOTER);
      expect(count(t)).toBe(1);
    });

    it('F5: SessionStart: the footer is the last line of the block, after the banner and the events', async () => {
      fake.unread = [...bcs(101, 101), ...dms(102, 102)];
      const t = text(await run('SessionStart', ccv3));
      expect(t).toContain('## Lane board continuous-claude');
      expect(t).toContain('<dm102>');
      expect(lastLine(t)).toBe(REPLY_FOOTER);
      expect(count(t)).toBe(1);
    });
  });
});

describe('U: pageUnread, the pure paging rule', () => {
  type R = { id: number; to_session_id: string | null };
  const b = (from: number, to: number): R[] => Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i, to_session_id: null }));
  const d = (from: number, to: number): R[] => Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i, to_session_id: 'me' }));
  const ids = (rs: R[]): number[] => rs.map((r) => r.id);
  const span = (from: number, to: number): number[] => ids(b(from, to));

  it('U1 (extra 1): cold, broadcasts 1..49 and 63..100, DMs 50..62: three pages, 63..88 never show', () => {
    const all = [...b(1, 49), ...d(50, 62), ...b(63, 100)];
    const p1 = pageUnread(all, { cold: true });
    expect(ids(p1.events)).toEqual(span(50, 61));
    expect(p1.sentinel).toBe(61);
    expect(p1.boardRow).toBeNull();
    expect([p1.cut, p1.cutDm, p1.skipped]).toEqual([13, 1, 75]);
    // Next prompt: the SQL returns the DM above the sentinel and every broadcast again (still cold).
    const p2 = pageUnread([...b(1, 49), ...d(62, 62), ...b(63, 100)], { cold: true });
    expect(ids(p2.events)).toEqual([62, ...span(89, 99)]);
    expect(p2.boardRow).toBe(99);
    expect(p2.sentinel).toBeNull();
    // Third prompt: warm at 99.
    const p3 = pageUnread(b(100, 100), { cold: false });
    expect(ids(p3.events)).toEqual([100]);
    expect(p3.boardRow).toBe(100);
    expect([p3.cut, p3.skipped]).toEqual([0, 0]);
  });

  it('U2: the page keeps the input (SQL id) order; nothing is sorted again', () => {
    const p = pageUnread([...b(5, 6), ...d(7, 7), ...b(8, 8)], { cold: false });
    expect(ids(p.events)).toEqual([5, 6, 7, 8]);
  });

  it('U3 (F6): nothing cut gives board row = newest unread and NO sentinel, DMs included', () => {
    const p = pageUnread([...b(5, 6), ...d(7, 7)], { cold: false });
    expect(p.boardRow).toBe(7);
    expect(p.sentinel).toBeNull();
    expect([p.cut, p.cutDm, p.skipped]).toEqual([0, 0, 0]);
  });

  it('U4 (B3): no board: oldest 12 DMs, sentinel on the 12th, no board row', () => {
    const p = pageUnread(d(1, 13), { cold: false, noBoard: true });
    expect(ids(p.events)).toEqual(span(1, 12));
    expect([p.boardRow, p.sentinel, p.cut, p.cutDm]).toEqual([null, 12, 1, 1]);
    const q = pageUnread(d(13, 13), { cold: false, noBoard: true });
    expect([q.boardRow, q.sentinel, q.cut, q.cutDm]).toEqual([null, 13, 0, 0]);
  });

  it('U5 (C4): while a DM is cut no broadcast is shown, and the board row sits one below the lowest unshown event', () => {
    const p = pageUnread([...b(1, 5), ...d(6, 18)], { cold: false });
    expect(ids(p.events)).toEqual(span(6, 17));
    expect([p.boardRow, p.sentinel, p.cut, p.cutDm]).toEqual([0, 17, 6, 1]);
    const q = pageUnread([...d(6, 18), ...b(19, 20)], { cold: false });
    expect([q.boardRow, q.sentinel]).toEqual([17, null]);
  });

  it('U6 (C2): cold with a cut DM has no board row and always a sentinel; the cold-skipped count is kept out of cut', () => {
    const p = pageUnread([...b(1, 20), ...d(21, 33)], { cold: true });
    expect(ids(p.events)).toEqual(span(21, 32));
    expect([p.boardRow, p.sentinel, p.cut, p.cutDm, p.skipped]).toEqual([null, 32, 13, 1, 8]);
  });

  /**
   * The invariant, over a matrix of shapes (F3, F4): a shown event is covered by what is written, and a cut event is
   * not. A broadcast is covered by the board row. A DM is covered by the highest written row, because the DM cursor
   * is the MAX over every row of the session.
   */
  describe('U7 (F3, F4): the written cursors cover every shown event and no cut event', () => {
    const shapes: Array<[string, R[], boolean]> = [
      ['warm, 14 broadcasts', b(101, 114), false],
      ['warm, 13 broadcasts then a DM', [...b(101, 113), ...d(114, 114)], false],
      ['warm, 5 broadcasts then 13 DMs', [...b(101, 105), ...d(106, 118)], false],
      ['warm, 13 DMs then 5 broadcasts', [...d(101, 113), ...b(114, 118)], false],
      ['warm, DM first then 20 broadcasts', [...d(101, 101), ...b(102, 121)], false],
      ['warm, 3 broadcasts, 13 DMs, 3 broadcasts', [...b(101, 103), ...d(104, 116), ...b(117, 119)], false],
      ['cold, 20 broadcasts then 3 DMs', [...b(201, 220), ...d(221, 223)], true],
      ['cold, 3 DMs then 30 broadcasts', [...d(201, 203), ...b(204, 233)], true],
      ['cold, 20 broadcasts then 13 DMs (a DM is cut)', [...b(1, 20), ...d(21, 33)], true],
      ['warm, nothing cut', [...b(101, 105), ...d(106, 108)], false],
    ];
    it.each(shapes)('%s', (_name, rows, cold) => {
      const p = pageUnread(rows, { cold });
      const shown = new Set(ids(p.events));
      // The expected skip comes from the rule (a cold start leaves out all but the newest 12 broadcasts), never from p.skipped.
      const broadcasts = rows.filter((r) => !r.to_session_id);
      const expectedSkip = cold ? Math.max(0, broadcasts.length - 12) : 0;
      expect(p.skipped, 'skipped count').toBe(expectedSkip);
      const skipped = new Set(ids(broadcasts).slice(0, expectedSkip));
      const maxRow = Math.max(p.boardRow ?? 0, p.sentinel ?? 0);
      const covered = (r: R): boolean => (r.to_session_id ? r.id <= maxRow : p.boardRow !== null && r.id <= p.boardRow);
      for (const r of rows) {
        if (shown.has(r.id)) expect(covered(r), `shown ${r.id} must be covered`).toBe(true);
        else if (!skipped.has(r.id)) expect(covered(r), `cut ${r.id} must NOT be covered`).toBe(false);
      }
      expect(p.events.length + p.cut + p.skipped).toBe(rows.length);
      expect(p.events.length).toBeLessThanOrEqual(12);
    });
  });
});
