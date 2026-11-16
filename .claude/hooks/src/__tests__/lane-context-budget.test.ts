/**
 * lane-context byte budgets (card coord-banner-page-budget, CONTRACT v2 clauses C1 to C10).
 *
 * Ways it can fail (the failure list of the contract; 7, 8, 14 and 15 run on a database or in lane.mjs):
 *   F1  a cursor passes a direct message that waits, or a board event that the share rule removed
 *   F2  a direct message shows after one that waits; an ordinary direct message is cut though it is not alone
 *   F3  a text over its budget writes a cursor; the fallback text of a path is wrong
 *   F4  the count uses .length, not UTF-8 bytes
 *   F5  a cut splits a code point; a long line with no space is not cut; the marker text is wrong
 *   F6  the fixed page lines (count, more, cold, footer) push a full page over its budget
 *   F9  a hostile header is over 5,000 bytes, or loses a never-cut line
 *   F10 the share rule: give-back, one level, the minimum, zero texts
 *   F11 the inbox hint: a row from before, a row written now, no row, a page that C2 stopped
 *   F13 the time check: above 3.0 s no cursor is written and the text is still sent
 *
 * The database is a stub that records SQL. The real SQL runs in lane-context-db.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const fake = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] | undefined }>,
  mine: [] as Row[],
  claimable: [] as Row[],
  reminders: [] as Row[],
  peers: [] as Row[],
  unread: [] as Row[],
  lanes: [] as Row[],
  /** B1: when set, the lane_watermark upsert throws (the client-side query timeout). Nothing else throws. */
  failUpsert: false,
}));

vi.mock('pg', () => {
  class Client {
    on(): this { return this; }
    async connect(): Promise<void> { /* connected */ }
    async end(): Promise<void> { /* closed */ }
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      fake.calls.push({ sql, params });
      if (/INSERT INTO agentic_os\.lane_watermark/.test(sql)) {
        if (fake.failUpsert) throw new Error('Query read timeout');
        return { rows: [] };
      }
      if (/FROM agentic_os\.lane WHERE id = ANY/.test(sql)) return { rows: fake.lanes };
      if (/state IN \('ready','backlog'\)/.test(sql)) return { rows: fake.claimable };
      if (/remind_state IN/.test(sql)) return { rows: fake.reminders };
      if (/FROM sessions s/.test(sql)) return { rows: fake.peers };
      if (/FROM agentic_os\.lane_event e\b/.test(sql)) return { rows: fake.unread };
      if (/WHERE owner_session_id=\$1 AND state<>'done'/.test(sql)) return { rows: fake.mine };
      return { rows: [] };
    }
  }
  return { Client, default: { Client } };
});

import {
  boardFallback, cutBody, cutMarker, cutToBytes, namesInbox, noBoardFallback, pageUnread, runLaneContext,
  scopeCutMarker, shareBytes, utf8Bytes,
} from '../lane-context.js';

const ME = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const PEER = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const SHIM = 'node C:/Users/Tester/.claude/scripts/lane.mjs';
const FOOTER = 'A DM with a decision, a finding or a request: reply one time (M4.14).';
const NL = '\n';
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

let tmp: string;
let ccv3: string;
let nowhere: string;
const keys = ['LANE_REGISTRY_PATH', 'DATABASE_URL', 'CONTINUOUS_CLAUDE_DB_URL', 'CCV3_IDENTITY_DIR', 'CCV3_USER_HOME',
  'LANE_BOARD_CACHE', 'LANE_CONTEXT_ERROR_LOG', 'CLAUDE_CODE_ENTRYPOINT', 'LANE_CONTEXT_HEADLESS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of keys) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'lc-budget-'));
  ccv3 = join(tmp, 'ccv3'); nowhere = join(tmp, 'nowhere');
  for (const d of [ccv3, nowhere]) mkdirSync(d, { recursive: true });
  writeFileSync(join(tmp, 'registry.json'), JSON.stringify({ projects: [
    { name: 'CCv3', key: 'continuous-claude', path: ccv3, status: 'active' },
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
  fake.calls.length = 0;
  fake.failUpsert = false;
  fake.mine = []; fake.claimable = []; fake.reminders = []; fake.peers = []; fake.unread = []; fake.lanes = [];
  // A young hook: the C10 time check passes unless a test says otherwise. The vitest worker is older than any hook.
  vi.spyOn(process, 'uptime').mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

type Out = { hookSpecificOutput?: { additionalContext: string } };
const run = async (event: string, cwd: string, opts?: Parameters<typeof runLaneContext>[1]): Promise<string> =>
  ((await runLaneContext(JSON.stringify({ session_id: ME, hook_event_name: event, cwd }), opts)) as Out)
    .hookSpecificOutput?.additionalContext ?? '';
const inserts = (): Array<{ sql: string; params: unknown[] | undefined }> =>
  fake.calls.filter((c) => /INSERT INTO agentic_os\.lane_watermark/.test(c.sql));
const tags = (t: string): string[] => [...t.matchAll(/<((?:bc|dm)\d+)>/g)].map((m) => m[1]);

/** An unread row. wm = board_wm: a number for a warm board, null for a cold one. */
const ev = (id: number, tag: string, body: string, o: { dm?: boolean; wm?: number | null } = {}): Row => ({
  id, occurred_at: '', lane_id: null, kind: 'note', session_id: PEER, to_session_id: o.dm ? ME : null,
  body: `<${tag}>${body}`, project_key: 'continuous-claude', board_wm: o.wm === undefined ? 100 : o.wm,
});
const dm = (id: number, body = '', wm: number | null = 100): Row => ev(id, `dm${id}`, body, { dm: true, wm });
const bc = (id: number, body = '', wm: number | null = 100): Row => ev(id, `bc${id}`, body, { wm });
const markerRe = /…\[cut, (\d+) more bytes\. Full text: node C:\/Users\/Tester\/\.claude\/scripts\/lane\.mjs inbox --id (\d+)\]$/;

describe('F5: the cut and the markers', () => {
  it('F4: utf8Bytes counts bytes, not UTF-16 units', () => {
    expect(utf8Bytes('a€\u{1F600}')).toBe(8);
    expect(utf8Bytes('')).toBe(0);
  });

  it('cuts on a code-point boundary at each of the four byte offsets of a 4-byte character', () => {
    const s = 'ab\u{1F600}cd';
    expect(cutToBytes(s, 2)).toBe('ab');
    expect(cutToBytes(s, 3)).toBe('ab');
    expect(cutToBytes(s, 4)).toBe('ab');
    expect(cutToBytes(s, 5)).toBe('ab');
    expect(cutToBytes(s, 6)).toBe('ab\u{1F600}');
    expect(cutToBytes(s, 7)).toBe('ab\u{1F600}c');
  });

  it('cuts a 3-byte character only whole, returns the text when it fits, and gives "" for 0 or less', () => {
    expect(cutToBytes('a€b', 3)).toBe('a');
    expect(cutToBytes('a€b', 4)).toBe('a€');
    expect(cutToBytes('a€b', 99)).toBe('a€b');
    expect(cutToBytes('abc', 0)).toBe('');
    expect(cutToBytes('abc', -5)).toBe('');
  });

  it('the event marker and the scope marker, word for word', () => {
    expect(cutMarker(17, 42)).toBe(` …[cut, 17 more bytes. Full text: ${SHIM} inbox --id 42]`);
    expect(scopeCutMarker()).toBe(` …[cut: ${SHIM} board]`);
  });

  it('a body of one long line with no space is cut, ends with the exact marker, and fits its allowance', () => {
    const body = 'x'.repeat(1000);
    const out = cutBody(body, 500, 42);
    expect(bytes(out)).toBeLessThanOrEqual(500);
    const m = out.match(markerRe);
    expect(m, `no marker in ${out.slice(-120)}`).not.toBeNull();
    const shown = out.slice(0, out.length - cutMarker(Number(m![1]), 42).length);
    expect(shown).toBe('x'.repeat(shown.length));
    expect(shown.length + Number(m![1])).toBe(1000);
    expect(m![2]).toBe('42');
  });

  it('a body that fits is returned whole, with no marker', () => {
    expect(cutBody('short body', 500, 7)).toBe('short body');
  });

  it('a multi-byte body: the marker counts bytes, and the shown part is whole characters', () => {
    const body = '€'.repeat(400); // 1,200 bytes
    const out = cutBody(body, 600, 9);
    expect(bytes(out)).toBeLessThanOrEqual(600);
    const m = out.match(markerRe)!;
    const shown = out.slice(0, out.length - cutMarker(Number(m[1]), 9).length);
    expect(shown).toBe('€'.repeat(shown.length));
    expect(bytes(shown) + Number(m[1])).toBe(1200);
  });
});

describe('F10: shareBytes, the share rule (C6)', () => {
  it('zero texts give an empty share', () => {
    expect(shareBytes([], 1000)).toEqual([]);
    expect(shareBytes([], 1000, 240)).toEqual([]);
  });

  it('give-back: a short text keeps its size and the rest goes to the long texts', () => {
    expect(shareBytes([100, 1000, 1000], 1100)).toEqual([100, 500, 500]);
  });

  it('one level: every long text is cut to the same size, in input order', () => {
    expect(shareBytes([900, 800, 1000], 1500)).toEqual([500, 500, 500]);
  });

  it('texts that all fit keep their sizes', () => {
    expect(shareBytes([10, 20, 30], 1000)).toEqual([10, 20, 30]);
  });

  it('the minimum: null when a cut text gets less than the minimum; a short text under the minimum is no cut', () => {
    expect(shareBytes([1000, 1000], 400, 240)).toBeNull();
    expect(shareBytes([1000, 1000], 480, 240)).toEqual([240, 240]);
    expect(shareBytes([50, 1000], 290, 240)).toEqual([50, 240]);
  });

  it('the total never passes the pool', () => {
    const s = shareBytes([333, 777, 1001, 5], 1000)!;
    expect(s.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
  });

  it('a negative pool gives null when there is a text, even an empty one; zero texts stay []', () => {
    expect(shareBytes([0, 0], -1)).toBeNull();
    expect(shareBytes([0, 0], -1, 240)).toBeNull();
    expect(shareBytes([], -1)).toEqual([]);
  });
});

describe('F11: namesInbox, the inbox hint (C9)', () => {
  it('a row from before names inbox', () => expect(namesInbox({ rowBefore: true, rowWritten: false })).toBe(true));
  it('a row that this page writes names inbox', () => expect(namesInbox({ rowBefore: false, rowWritten: true })).toBe(true));
  it('no row names no inbox', () => expect(namesInbox({ rowBefore: false, rowWritten: false })).toBe(false));

  it('a cold page that writes the board row names inbox in its more line', async () => {
    fake.unread = [...Array.from({ length: 20 }, (_, i) => bc(201 + i, '', null)), dm(221, '', null), dm(222, '', null), dm(223, '', null)];
    const t = await run('UserPromptSubmit', ccv3);
    expect(t).toContain(`(3 more unread. Later prompts show them, oldest first, or run: ${SHIM} inbox)`);
    expect(inserts()[0].params).toEqual([ME, 217, `${ME}@`, 223]);
  });

  it('a page that C2 stopped has no more line and writes no row', async () => {
    fake.unread = Array.from({ length: 20 }, (_, i) => bc(201 + i, '', null));
    const t = await run('UserPromptSubmit', ccv3, { budgets: { prompt: 100 } });
    expect(t).toBe(boardFallback('continuous-claude', '#aaaaaaaa', null));
    expect(t).not.toMatch(/more unread/);
    expect(inserts()).toHaveLength(0);
  });

  it('a cold page that would write the row but is late (C10) names no inbox', async () => {
    vi.spyOn(process, 'uptime').mockReturnValue(3.5);
    fake.unread = [...Array.from({ length: 20 }, (_, i) => bc(201 + i, '', null)), dm(221, '', null), dm(222, '', null), dm(223, '', null)];
    const t = await run('UserPromptSubmit', ccv3);
    expect(t).toContain('(3 more unread. Later prompts show them, oldest first.)');
    expect(t).not.toMatch(/inbox/);
    expect(inserts()).toHaveLength(0);
  });
});

describe('F3: the fallback texts and the write order (C2)', () => {
  it('the board fallback, word for word, with and without a waiting direct message', () => {
    expect(boardFallback('continuous-claude', 'trex #aaaaaaaa', 77)).toBe([
      '## Lane board continuous-claude (concurrent sessions on this board)',
      'You are trex #aaaaaaaa.',
      `Lane text over its budget. Run: ${SHIM} board`,
      `Oldest direct message: ${SHIM} inbox --id 77`,
    ].join(NL));
    expect(boardFallback('continuous-claude', '#aaaaaaaa', null)).toBe([
      '## Lane board continuous-claude (concurrent sessions on this board)',
      'You are #aaaaaaaa.',
      `Lane text over its budget. Run: ${SHIM} board`,
    ].join(NL));
  });

  it('the no-board fallback, word for word', () => {
    expect(noBoardFallback(77)).toBe(`A direct message waits. Run: ${SHIM} inbox --id 77`);
  });

  it('a prompt page over its budget sends the board fallback and writes no cursor', async () => {
    fake.unread = [bc(101, 'a'.repeat(100)), bc(102), dm(103), dm(104)];
    const t = await run('UserPromptSubmit', ccv3, { budgets: { prompt: 120 } });
    expect(t).toBe(boardFallback('continuous-claude', '#aaaaaaaa', 103));
    expect(inserts()).toHaveLength(0);
  });

  it('a SessionStart text over its budget sends the board fallback and writes no cursor', async () => {
    fake.unread = [bc(101), dm(102)];
    const t = await run('SessionStart', ccv3, { budgets: { start: 300 } });
    expect(t).toBe(boardFallback('continuous-claude', '#aaaaaaaa', 102));
    expect(inserts()).toHaveLength(0);
  });

  it('the no-board page is built and measured BEFORE its write: over budget it sends the fallback and writes nothing', async () => {
    fake.unread = [dm(101, 'hello'), dm(102)];
    const t = await run('UserPromptSubmit', nowhere, { budgets: { noBoard: 60 } });
    expect(t).toBe(noBoardFallback(101));
    expect(inserts()).toHaveLength(0);
  });

  it('the no-board page in its budget sends the page and writes the sentinel', async () => {
    fake.unread = [dm(101, 'hello'), dm(102)];
    const t = await run('UserPromptSubmit', nowhere);
    expect(tags(t)).toEqual(['dm101', 'dm102']);
    expect(inserts()[0].params).toEqual([`${ME}@`, 102]);
  });
});

describe('F2, F4: direct messages are whole, oldest first, a prefix in id order (C5a)', () => {
  it('F2: a DM after one that waits never shows, though it fits; the DM that fits is whole, not cut', async () => {
    fake.unread = [dm(101, 'a'.repeat(1000)), dm(102, 'b'.repeat(5000)), dm(103, 'c')];
    const t = await run('UserPromptSubmit', ccv3);
    expect(tags(t)).toEqual(['dm101']);
    expect(t).toContain(`<dm101>${'a'.repeat(1000)}`);
    expect(t).not.toMatch(/\[cut,/);
    expect(t).toContain('(2 more unread, 2 direct to you.');
    expect(inserts()[0].params).toEqual([ME, 101]);
  });

  it('F2: no board event shows while a DM waits', async () => {
    fake.unread = [bc(101), dm(102, 'a'.repeat(3000)), dm(103, 'b'.repeat(3000)), bc(104)];
    const t = await run('UserPromptSubmit', ccv3);
    expect(tags(t)).toEqual(['dm102']);
    // The board row stays below bc101 (not shown); the sentinel covers dm102 only, never dm103.
    expect(inserts()[0].params).toEqual([ME, 100, `${ME}@`, 102]);
  });

  it('F4: the count is UTF-8 bytes: 3 DMs of 1,500 "€" (4,500 bytes each) show one, not three', async () => {
    fake.unread = [dm(101, '€'.repeat(1500)), dm(102, '€'.repeat(1500)), dm(103, '€'.repeat(1500))];
    const t = await run('UserPromptSubmit', ccv3);
    expect(tags(t)).toEqual(['dm101']);
    expect(t).toContain(`<dm101>${'€'.repeat(1500)}`);
    expect(bytes(t)).toBeLessThanOrEqual(6000);
    expect(inserts()[0].params).toEqual([ME, 101]);
  });

  it('C5b: the oldest DM alone over the space shows alone, cut, with the marker, and counts as shown', async () => {
    const big = 'y'.repeat(9000);
    fake.unread = [dm(101, big), dm(102), bc(103)];
    const t = await run('UserPromptSubmit', ccv3);
    expect(tags(t)).toEqual(['dm101']);
    const line = t.split(NL).find((l) => l.includes('<dm101>')) ?? '';
    const m = line.match(markerRe);
    expect(m, 'no marker on the cut line').not.toBeNull();
    expect(m![2]).toBe('101');
    const shown = line.slice(line.indexOf('<dm101>'), line.length - cutMarker(Number(m![1]), 101).length);
    expect(bytes(shown) + Number(m![1])).toBe(bytes(`<dm101>${big}`));
    expect(bytes(t)).toBeLessThanOrEqual(6000);
    expect(inserts()[0].params).toEqual([ME, 101]);
  });
});

describe('F1: pageUnread with bytes: no cursor passes an event that is not on the page', () => {
  type R = { id: number; to_session_id: string | null; body: string };
  const D = (id: number, n: number): R => ({ id, to_session_id: 'me', body: 'd'.repeat(n) });
  const B = (id: number, n: number): R => ({ id, to_session_id: null, body: 'b'.repeat(n) });
  const opts = (space: number) => ({ cold: false, bytes: { space, prefix: () => '- p: ', body: (e: R) => e.body } });
  const maxRow = (p: { boardRow: number | null; sentinel: number | null }): number => Math.max(p.boardRow ?? 0, p.sentinel ?? 0);

  it('a DM that waits is above both cursors, and so is every later DM', () => {
    const p = pageUnread([D(1, 100), D(2, 3000), D(3, 10)], opts(2000));
    expect(p.events.map((e) => e.id)).toEqual([1]);
    expect([p.cut, p.cutDm]).toEqual([2, 2]);
    expect(maxRow(p)).toBe(1);
  });

  it('removed board events stay above the board row; the shown ones are a prefix and each is cut with the marker', () => {
    const rows = [B(1, 2000), B(2, 2000), B(3, 2000), B(4, 2000), B(5, 2000)];
    const p = pageUnread(rows, opts(1200));
    const shown = p.events.map((e) => e.id);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(5);
    expect(shown).toEqual(rows.slice(0, shown.length).map((r) => r.id));
    expect(p.boardRow).toBe(shown[shown.length - 1]);
    expect(p.cut).toBe(5 - shown.length);
    let used = 0;
    for (const id of shown) {
      const b = p.bodies!.get(id)!;
      const m = b.match(markerRe);
      expect(m).not.toBeNull();
      // The kept body is the text before the real marker: at least 240 bytes (C5c).
      expect(bytes(b) - bytes(cutMarker(Number(m![1]), id))).toBeGreaterThanOrEqual(240);
      used += bytes(`- p: ${b}`) + 1;
    }
    expect(used).toBeLessThanOrEqual(1200);
  });

  it('C5c minimum at its edge: a share of 239 body bytes plus the marker removes the newest event', () => {
    // Two events of 2000 bytes. Each line costs its prefix ("- p: " and a newline, 6 bytes) and its share.
    const m = bytes(cutMarker(2000, 1));
    const at = (bodyShare: number): number[] => pageUnread([B(1, 2000), B(2, 2000)], opts(2 * (bodyShare + m) + 12)).events.map((e) => e.id);
    expect(at(240)).toEqual([1, 2]);
    expect(at(239)).toEqual([1]);
  });

  it('C5c: board events with empty bodies whose line prefixes do not fit: the newest are removed, the page fits', () => {
    const rows = Array.from({ length: 12 }, (_, i) => B(i + 1, 0));
    const p = pageUnread(rows, opts(30)); // 5 lines of 6 bytes fit, 12 do not
    expect(p.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(p.cut).toBe(7);
    expect(p.boardRow).toBe(5);
  });

  it('board events that fit are whole; a short one gives its share back to a long one', () => {
    const p = pageUnread([B(1, 50), B(2, 3000)], opts(2000));
    expect(p.bodies!.get(1)).toBe('b'.repeat(50));
    expect(p.bodies!.get(2)).toMatch(markerRe);
    expect(p.boardRow).toBe(2);
  });

  it('with no bytes option the page rule is the count rule of today', () => {
    const p = pageUnread([D(1, 9000), D(2, 9000)], { cold: false });
    expect(p.events.map((e) => e.id)).toEqual([1, 2]);
  });
});

describe('F6: the fixed page lines stay inside the budget', () => {
  it('12 events, a cold board, the more line and the footer: within 6,000 bytes, not the fallback, cursor written', async () => {
    fake.unread = [
      ...Array.from({ length: 40 }, (_, i) => bc(201 + i, 'q'.repeat(1000), null)),
      dm(241, 'hi', null), dm(242, 'there', null),
    ];
    const t = await run('UserPromptSubmit', ccv3);
    const lines = t.split(NL);
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(12);
    expect(t).toMatch(/older board events are not shown on your first look/);
    expect(t).toMatch(/more unread/);
    expect(lines[lines.length - 1]).toBe(FOOTER);
    expect(bytes(t)).toBeLessThanOrEqual(6000);
    expect(t).not.toContain('Lane text over its budget');
    expect(inserts()).toHaveLength(1);
  });

  it('C5c: two whole DMs, then 10 claims with no body: never the fallback, and a cursor is written (DM sizes 2,400 to 3,000)', async () => {
    // `claim` with no --note writes a NULL body. The line prefixes of the claims must come out of the space the DMs leave.
    const claim = (id: number): Row => ({ id, occurred_at: '', lane_id: `claimed-lane-with-a-long-id-${id}`, kind: 'claimed',
      session_id: PEER, to_session_id: null, body: null, project_key: 'continuous-claude', board_wm: 100 });
    const failed: number[] = [];
    for (let size = 2400; size <= 3000; size += 5) {
      fake.calls.length = 0;
      fake.unread = [dm(101, 'm'.repeat(size)), dm(102, 'n'.repeat(size)), ...Array.from({ length: 10 }, (_, i) => claim(103 + i))];
      const t = await run('UserPromptSubmit', ccv3);
      if (t.includes('Lane text over its budget') || inserts().length !== 1 || bytes(t) > 6000) failed.push(size);
    }
    expect(failed, `sizes that sent the fallback or wrote no cursor: ${failed.join(', ')}`).toEqual([]);
  });
});

describe('C4: an event line never prints a lane id over 64 bytes (the id is not printed, never printed cut)', () => {
  const TAG = ' [lane id not shown]';
  const withLane = (row: Row, laneId: string): Row => ({ ...row, lane_id: laneId });

  it('a board event with a 6,000-byte lane id does not stop the page: all 3 show, the tag stands for the id, the cursor passes all 3', async () => {
    const long = 'L'.repeat(6000);
    fake.unread = [withLane(bc(101, 'one'), long), bc(102, 'two'), bc(103, 'three')];
    const t = await run('UserPromptSubmit', ccv3);
    expect(tags(t)).toEqual(['bc101', 'bc102', 'bc103']);
    const first = t.split(NL).find((l) => l.includes('<bc101>')) ?? '';
    expect(first).toContain(`note${TAG}: <bc101>one`);
    expect(t).not.toContain('LLLL');
    expect(bytes(t)).toBeLessThanOrEqual(6000);
    expect(t).not.toContain('Lane text over its budget');
    expect(inserts()[0].params).toEqual([ME, 103]);
  });

  it('a lane id of exactly 64 bytes prints in full; one of 65 bytes prints the tag', async () => {
    const id64 = 'a'.repeat(64);
    const id65 = 'k'.repeat(65);
    fake.unread = [withLane(bc(101, 'one'), id64), withLane(bc(102, 'two'), id65)];
    const t = await run('UserPromptSubmit', ccv3);
    const lines = t.split(NL);
    expect(lines.find((l) => l.includes('<bc101>'))).toContain(` [${id64}]: <bc101>`);
    const second = lines.find((l) => l.includes('<bc102>')) ?? '';
    expect(second).toContain(`${TAG}: <bc102>`);
    expect(second).not.toContain('kkkk');
  });

  it('a direct message with a 6,000-byte lane id is whole, with the tag: not cut, not the fallback text', async () => {
    fake.unread = [withLane(dm(101, 'hello'), 'L'.repeat(6000))];
    const t = await run('UserPromptSubmit', ccv3);
    expect(tags(t)).toEqual(['dm101']);
    expect(t).toContain(`${TAG} (direct to you): <dm101>hello`);
    expect(t).not.toMatch(/\[cut,/);
    expect(t).not.toContain('Lane text over its budget');
    expect(t).not.toContain('LLLL');
    expect(bytes(t)).toBeLessThanOrEqual(6000);
    expect(inserts()[0].params).toEqual([ME, 101]);
  });
});

describe('C4: an event line never prints a board key or a kind over 64 bytes (the same rule as the lane id)', () => {
  const FROM_TAG = ' [from board not shown]';
  const withKind = (row: Row, kind: string): Row => ({ ...row, kind });
  const withBoard = (row: Row, key: string): Row => ({ ...row, project_key: key });

  it('a board event with a 6,000-byte kind does not stop the page: all 3 show, the text is within 6,000 bytes, the cursor passes all 3', async () => {
    fake.unread = [withKind(bc(101, 'one'), 'K'.repeat(6000)), bc(102, 'two'), bc(103, 'three')];
    const t = await run('UserPromptSubmit', ccv3);
    expect(tags(t)).toEqual(['bc101', 'bc102', 'bc103']);
    const first = t.split(NL).find((l) => l.includes('<bc101>')) ?? '';
    expect(first).toContain(' kind not shown: <bc101>one');
    expect(t).not.toContain('KKKK');
    expect(bytes(t)).toBeLessThanOrEqual(6000);
    expect(t).not.toContain('Lane text over its budget');
    expect(inserts()[0].params).toEqual([ME, 103]);
  });

  it('a direct message from another board with a 6,000-byte board key is whole, with the tag: not cut, not the fallback text', async () => {
    fake.unread = [withBoard(dm(101, 'hello'), 'B'.repeat(6000))];
    const t = await run('UserPromptSubmit', ccv3);
    expect(tags(t)).toEqual(['dm101']);
    expect(t).toContain(`${FROM_TAG} note (direct to you): <dm101>hello`);
    expect(t).not.toMatch(/\[cut,/);
    expect(t).not.toContain('Lane text over its budget');
    expect(t).not.toContain('BBBB');
    expect(bytes(t)).toBeLessThanOrEqual(6000);
    expect(inserts()[0].params).toEqual([ME, 101]);
  });

  it('a board key of exactly 64 bytes prints in full; one of 65 bytes prints the tag', async () => {
    const key64 = 'a'.repeat(64);
    const key65 = 'k'.repeat(65);
    fake.unread = [withBoard(dm(101, 'one'), key64), withBoard(dm(102, 'two'), key65)];
    const lines = (await run('UserPromptSubmit', ccv3)).split(NL);
    expect(lines.find((l) => l.includes('<dm101>'))).toContain(` [from ${key64}] note`);
    const second = lines.find((l) => l.includes('<dm102>')) ?? '';
    expect(second).toContain(`${FROM_TAG} note`);
    expect(second).not.toContain('kkkk');
  });

  it('a kind of exactly 64 bytes prints in full; one of 65 bytes prints "kind not shown"', async () => {
    const kind64 = 'a'.repeat(64);
    const kind65 = 'k'.repeat(65);
    fake.unread = [withKind(bc(101, 'one'), kind64), withKind(bc(102, 'two'), kind65)];
    const lines = (await run('UserPromptSubmit', ccv3)).split(NL);
    expect(lines.find((l) => l.includes('<bc101>'))).toContain(` ${kind64}: <bc101>`);
    const second = lines.find((l) => l.includes('<bc102>')) ?? '';
    expect(second).toContain(' kind not shown: <bc102>');
    expect(second).not.toContain('kkkk');
  });
});

describe('C3: each budget holds from both sides (a DM that just fits is whole; one byte more is cut, in the budget)', () => {
  /** The text for one DM of `pad` bytes, and whether it is cut. */
  const page = async (event: string, cwd: string, pad: number): Promise<{ t: string; cut: boolean }> => {
    fake.calls.length = 0;
    // Each probe is a fresh look: a cut page leaves an id in the CUT, NOT READ state, and its line would shrink the next page.
    rmSync(join(tmp, 'lane-cut'), { recursive: true, force: true });
    fake.unread = [dm(101, 'w'.repeat(pad))];
    const t = await run(event, cwd);
    return { t, cut: /\[cut,/.test(t) };
  };
  /** The largest pad that shows whole. A DM shows whole while it fits, so the search is monotone. */
  const largestWhole = async (event: string, cwd: string): Promise<number> => {
    let lo = 0;
    let hi = 20000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((await page(event, cwd, mid)).cut) hi = mid - 1; else lo = mid;
    }
    return lo;
  };
  // The tolerance is the reserve for the fixed lines that a one-DM page does not print (the more line, the cold line).
  const TOLERANCE = 400;
  const FALLBACK = /over its budget|A direct message waits\. Run/;
  const cases: Array<[string, string, () => string, number]> = [
    ['SessionStart (8,000)', 'SessionStart', () => ccv3, 8000],
    ['prompt (6,000)', 'UserPromptSubmit', () => ccv3, 6000],
    ['no-board (6,000)', 'UserPromptSubmit', () => nowhere, 6000],
  ];
  for (const [name, event, cwd, budget] of cases) {
    it(name, async () => {
      const n = await largestWhole(event, cwd());
      const whole = await page(event, cwd(), n);
      expect(whole.t).not.toMatch(FALLBACK);
      expect(bytes(whole.t)).toBeLessThanOrEqual(budget);
      expect(bytes(whole.t), `a whole DM page of ${bytes(whole.t)} bytes`).toBeGreaterThan(budget - TOLERANCE);
      const over = await page(event, cwd(), n + 1);
      expect(over.cut).toBe(true);
      expect(over.t).not.toMatch(FALLBACK);
      expect(bytes(over.t)).toBeLessThanOrEqual(budget);
      expect(bytes(over.t)).toBeGreaterThan(budget - TOLERANCE);
    });
  }
});

describe('C5: the page reserve holds the count line', () => {
  const COLD = '  (12 older board events are not shown on your first look at this board.)';

  it('the fullest page of 12 direct messages is within 6,000 bytes and leaves room for the cold line only', async () => {
    // Warm board, 12 DMs. The first is small. The size of the second grows until it no longer shows. The other ten never
    // fit after it, so the page prints: the count line, 2 DMs, the more line and the footer. Only the cold line is not printed.
    const page = async (size: number): Promise<string> => {
      fake.calls.length = 0;
      fake.unread = [dm(101, 'a'), dm(102, 'b'.repeat(size)), ...Array.from({ length: 10 }, (_, i) => dm(103 + i, 'c'.repeat(2000)))];
      return run('UserPromptSubmit', ccv3);
    };
    let lo = 0;
    let hi = 6000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (tags(await page(mid)).includes('dm102')) lo = mid; else hi = mid - 1;
    }
    const t = await page(lo);
    expect(tags(t)).toEqual(['dm101', 'dm102']);
    expect(t).toMatch(/^## 12 lane update\(s\) since you last looked/);
    expect(t).toMatch(/\(10 more unread, 10 direct to you\./);
    expect(t.endsWith(FOOTER)).toBe(true);
    expect(bytes(t)).toBeLessThanOrEqual(6000);
    // The reserve holds the count line, so the room left is the cold line (and its two line ends), not less.
    const room = 6000 - bytes(t);
    expect(room, `a full page of ${bytes(t)} bytes leaves ${room}`).toBeGreaterThanOrEqual(bytes(COLD));
    expect(room, `a full page of ${bytes(t)} bytes leaves ${room}`).toBeLessThanOrEqual(bytes(COLD) + 2);
  });
});

describe('F9: the SessionStart header (C4)', () => {
  const long = (p: string): string => `${p}-${'z'.repeat(70)}`;
  const held = (id: string, board = 'continuous-claude'): Row =>
    ({ id, title: 't', track: 'x', state: 'active', scope: 'RELATES TO: r-1, r-2, r-3', band: 'P1', project_key: board, owner_session_id: ME });
  const hostile = (): void => {
    fake.mine = [...Array.from({ length: 11 }, (_, i) => held(`my-${i + 1}`)), held(long('mylong')),
      held(long('far'), 'zz-board'), held('far-2', 'zz-board')];
    fake.lanes = [{ id: 'r-1', owner_session_id: PEER, reclaimable: false }];
    fake.peers = Array.from({ length: 10 }, (_, i) => ({
      sid: `bbbbbbbb-0000-4000-8000-00000000000${i}`,
      lanes: [`p${i}-a`, `p${i}-b`, long(`p${i}`), `p${i}-c`, `p${i}-d`].join(', '),
      scopes: 's'.repeat(2000), total: 14,
    }));
    const past = new Date(Date.now() - 3 * 3600_000).toISOString();
    fake.reminders = Array.from({ length: 5 }, (_, i) => ({
      id: i === 0 ? long('rem') : `rem-${i}`, title: 'r'.repeat(300), band: 'P1', due_at: past,
      remind_state: 'scheduled', action_id: null, total: 7,
    }));
    fake.claimable = Array.from({ length: 5 }, (_, i) => ({ id: i === 0 ? long('cl') : `cl-${i}`, title: 'c'.repeat(300), band: 'P2' }));
  };
  /** The banner part of a SessionStart text: everything before the "## N lane update(s)" block. */
  const header = (t: string): string => {
    const at = t.search(/\n\n## \d+ lane update/);
    return at < 0 ? t : t.slice(0, at);
  };

  it('the hostile fixture is over 5,000 bytes before any collapse, so the cases here run the collapse', async () => {
    hostile();
    expect(bytes(header(await run('SessionStart', ccv3, { budgets: { header: 1e9 } })))).toBeGreaterThan(5000);
  });

  it('ids of exactly 64 bytes in every list are printed, and the header still fits 5,000 bytes', async () => {
    hostile();
    const id64 = (p: string): string => `${p}-${'k'.repeat(63 - p.length)}`;
    fake.mine = [
      ...Array.from({ length: 12 }, (_, i) => ({ ...held(id64(`h${i}`)),
        scope: `RELATES TO: ${Array.from({ length: 10 }, (_, j) => id64(`r${j}`)).join(', ')}` })),
      ...Array.from({ length: 6 }, (_, i) => held(id64(`f${i}`), 'zz-board')),
    ];
    fake.peers = fake.peers.map((p, i) => ({ ...p, lanes: [id64(`a${i}`), id64(`b${i}`), id64(`c${i}`), id64(`d${i}`)].join(', ') }));
    const h = header(await run('SessionStart', ccv3));
    expect(bytes(id64('h0'))).toBe(64);
    expect(h).toContain(id64('h7'));
    expect(bytes(h), `header is ${bytes(h)} bytes`).toBeLessThanOrEqual(5000);
  });

  it('the collapse order: peer scopes first, then Claimable, then Reminders, each one line', async () => {
    const at = async (limit: number): Promise<string[]> => {
      hostile();
      fake.calls.length = 0;
      return header(await run('SessionStart', ccv3, { budgets: { header: limit } })).split(NL);
    };
    const SCOPES = `     scopes: ${SHIM} board`;
    const CLAIM = `Claimable (claim by id): ${SHIM} next`;
    const REM = `## Reminders due (7): ${SHIM} remind list`;
    const none = await at(1e9);
    expect(none.some((l) => l.startsWith('     scope: '))).toBe(true);
    expect(none).toContain('Claimable (claim by id):');
    expect(none).toContain('## Reminders due (7)');
    const one = await at(5000);
    expect(one).toContain(SCOPES);
    expect(one.some((l) => l.startsWith('     scope: '))).toBe(false);
    expect(one).toContain('Claimable (claim by id):');
    expect(one).toContain('## Reminders due (7)');
    const two = await at(2500);
    expect(two).toContain(SCOPES);
    expect(two).toContain(CLAIM);
    expect(two).toContain('## Reminders due (7)');
    const three = await at(1000);
    expect(three).toEqual(expect.arrayContaining([SCOPES, CLAIM, REM]));
    expect(three).not.toContain('## Reminders due (7)');
  });

  it('a hostile header is at most 5,000 bytes and keeps every never-cut line', async () => {
    hostile();
    fake.unread = [bc(101, 'x'.repeat(200)), dm(102, 'hello')];
    const t = await run('SessionStart', ccv3);
    const h = header(t);
    expect(bytes(h), `header is ${bytes(h)} bytes`).toBeLessThanOrEqual(5000);
    const lines = h.split(NL);
    expect(lines[0]).toBe('## Lane board continuous-claude (concurrent sessions on this board)');
    expect(lines).toContain('You are #aaaaaaaa.');
    expect(lines.some((l) => l.startsWith('You hold: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('Milestone ('))).toBe(true);
    expect(lines.some((l) => l.startsWith('Related: '))).toBe(true);
    expect(lines.some((l) => l.startsWith(`Commands: ${SHIM} board`))).toBe(true);
    expect(lines).toContain('Serialize commits — same branch, two committers race .git/index.lock.');
    expect(bytes(t)).toBeLessThanOrEqual(8000);
    expect(tags(t)).toEqual(['bc101', 'dm102']);
    expect(inserts()).toHaveLength(1);
  });

  it('a header still over its budget after every collapse keeps all seven never-cut lines', async () => {
    hostile();
    const limit = 1000;
    const h = header(await run('SessionStart', ccv3, { budgets: { header: limit } }));
    // The premise: every section is already one line, and the header is still over. The never-cut lines stay anyway.
    expect(bytes(h), `header is ${bytes(h)} bytes`).toBeGreaterThan(limit);
    expect(h).toContain(`scopes: ${SHIM} board`);
    expect(h).toContain(`Claimable (claim by id): ${SHIM} next`);
    expect(h).not.toContain('## Reminders due (7)\n');
    const lines = h.split(NL);
    const never: Array<[string, (l: string) => boolean]> = [
      ['the board heading', (l) => l === '## Lane board continuous-claude (concurrent sessions on this board)'],
      ['You are', (l) => l === 'You are #aaaaaaaa.'],
      ['You hold', (l) => l.startsWith('You hold: ')],
      ['the Milestone line', (l) => l.startsWith('Milestone (')],
      ['the Related line', (l) => l.startsWith('Related: ')],
      ['the Commands line', (l) => l.startsWith(`Commands: ${SHIM} board`)],
      ['the Serialize line', (l) => l === 'Serialize commits — same branch, two committers race .git/index.lock.'],
    ];
    expect(never.filter(([, test]) => !lines.some(test)).map(([name]) => name), 'never-cut lines that are missing').toEqual([]);
  });

  it('no id over 64 bytes is printed; "You hold" shows 8 ids then +N more: mine; a peer line shows 3 ids then +N', async () => {
    hostile();
    const t = await run('SessionStart', ccv3);
    expect(t).not.toMatch(/z{70}/);
    const hold = t.split(NL).find((l) => l.startsWith('You hold: ')) ?? '';
    expect(hold).toBe(`You hold: ${Array.from({ length: 8 }, (_, i) => `P1 my-${i + 1}`).join(', ')}, +4 more: ${SHIM} mine`);
    const peer = t.split(NL).find((l) => l.includes('#bbbbbbbb') && l.includes(' holds ')) ?? '';
    expect(peer).toMatch(/ holds p\d-a, p\d-b, p\d-c, \+2$/);
  });

  it('peer scopes share 2,400 bytes and a cut scope ends with the scope marker', async () => {
    fake.peers = Array.from({ length: 3 }, (_, i) => ({
      sid: `bbbbbbbb-0000-4000-8000-00000000001${i}`, lanes: `q${i}-a`, scopes: (i === 0 ? 'short scope' : 's'.repeat(2000)), total: 3,
    }));
    const t = await run('SessionStart', ccv3);
    const scopes = t.split(NL).filter((l) => l.startsWith('     scope: ')).map((l) => l.slice('     scope: '.length));
    expect(scopes).toHaveLength(3);
    expect(scopes[0]).toBe('short scope');
    for (const s of scopes.slice(1)) expect(s.endsWith(scopeCutMarker())).toBe(true);
    expect(scopes.reduce((a, s) => a + bytes(s), 0)).toBeLessThanOrEqual(2400);
    expect(bytes(scopes[1])).toBeGreaterThan(1000);
  });

  it('the Related line is never dropped: when every related id is over 64 bytes it reads "Related: +N more"', async () => {
    fake.mine = [{ ...held('my-1'), scope: `RELATES TO: ${long('ra')}, ${long('rb')}` }];
    const lines = header(await run('SessionStart', ccv3)).split(NL);
    expect(lines).toContain('Related: +2 more');
    expect(lines.join(NL)).not.toMatch(/z{70}/);
  });

  it('other boards: 5 ids, then "+N more: mine"; a hidden long id counts in N', async () => {
    fake.mine = [held('h-1'), ...['o-1', 'o-2', long('o'), 'o-3', 'o-4', 'o-5', 'o-6'].map((id) => held(id, 'zz-board'))];
    const line = header(await run('SessionStart', ccv3)).split(NL).find((l) => l.includes(' on other boards: ')) ?? '';
    const five = ['o-1', 'o-2', 'o-3', 'o-4', 'o-5'].map((id) => `${id}@zz-board`).join(', ');
    expect(line).toBe(`+7 on other boards: ${five}, +2 more: ${SHIM} mine`);
  });

  it('titles in the Claimable and Reminders lines are clipped to 100 bytes', async () => {
    fake.claimable = [{ id: 'cl-1', title: 'c'.repeat(300), band: 'P2' }];
    fake.reminders = [{ id: 'rem-1', title: 'r'.repeat(300), band: 'P1', due_at: new Date(Date.now() - 60_000).toISOString(), remind_state: 'scheduled', action_id: null, total: 1 }];
    const t = await run('SessionStart', ccv3);
    expect(t).toContain(`cl-1${' '.repeat(24)} ${'c'.repeat(100)}`);
    expect(t).not.toContain('c'.repeat(101));
    expect(t).not.toContain('r'.repeat(101));
    expect(t).toContain('r'.repeat(100));
  });
});

describe('F13: the time check (C10)', () => {
  it('above 3.0 s the text is sent and no cursor is written', async () => {
    vi.spyOn(process, 'uptime').mockReturnValue(3.01);
    fake.unread = [bc(101), dm(102)];
    const t = await run('UserPromptSubmit', ccv3);
    expect(tags(t)).toEqual(['bc101', 'dm102']);
    expect(inserts()).toHaveLength(0);
  });

  it('at 3.0 s or less the cursor is written', async () => {
    vi.spyOn(process, 'uptime').mockReturnValue(3.0);
    fake.unread = [bc(101), dm(102)];
    await run('UserPromptSubmit', ccv3);
    expect(inserts()[0].params).toEqual([ME, 102]);
  });

  it('an injected clock wins over process.uptime', async () => {
    fake.unread = [dm(101)];
    const t = await run('UserPromptSubmit', nowhere, { uptime: () => 9 });
    expect(tags(t)).toEqual(['dm101']);
    expect(inserts()).toHaveLength(0);
  });

  it('SessionStart above 3.0 s: the banner is sent and no cursor is written', async () => {
    vi.spyOn(process, 'uptime').mockReturnValue(4);
    fake.unread = [bc(101)];
    const t = await run('SessionStart', ccv3);
    expect(t).toContain('## Lane board continuous-claude');
    expect(tags(t)).toEqual(['bc101']);
    expect(inserts()).toHaveLength(0);
  });

  describe('a skipped cursor write leaves one trace in the error log', () => {
    const stamp = (): string => join(tmpdir(), `claude-lane-err-${ME}.json`);
    const logLines = (): Array<{ event: string; session: string; error: string }> =>
      existsSync(process.env.LANE_CONTEXT_ERROR_LOG as string)
        ? readFileSync(process.env.LANE_CONTEXT_ERROR_LOG as string, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
    // The logger throttles per session through a stamp file in the temp folder. Clear it so a run is not throttled.
    beforeEach(() => { rmSync(stamp(), { force: true }); });
    afterEach(() => { rmSync(stamp(), { force: true }); });

    it('board path: late with events sends the text, writes no cursor and logs one "late <s>s: cursor write skipped" line', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(4.25);
      fake.unread = [bc(101), dm(102)];
      const t = await run('UserPromptSubmit', ccv3);
      expect(tags(t)).toEqual(['bc101', 'dm102']);
      expect(inserts()).toHaveLength(0);
      const log = logLines();
      expect(log).toHaveLength(1);
      expect(log[0].error).toBe('late 4.25s: cursor write skipped');
      expect(log[0].event).toBe('UserPromptSubmit');
      expect(log[0].session).toBe(ME);
    });

    it('no-board path: late with a direct message sends the text, writes no cursor and logs one line', async () => {
      fake.unread = [dm(101)];
      const t = await run('UserPromptSubmit', nowhere, { uptime: () => 5.5 });
      expect(tags(t)).toEqual(['dm101']);
      expect(inserts()).toHaveLength(0);
      const log = logLines();
      expect(log).toHaveLength(1);
      expect(log[0].error).toBe('late 5.50s: cursor write skipped');
    });

    it('not late: the cursor is written and nothing is logged (both paths)', async () => {
      fake.unread = [bc(101), dm(102)];
      await run('UserPromptSubmit', ccv3);
      expect(inserts()).toHaveLength(1);
      fake.calls.length = 0;
      fake.unread = [dm(103)];
      await run('UserPromptSubmit', nowhere);
      expect(inserts()).toHaveLength(1);
      expect(logLines()).toEqual([]);
    });

    it('late with nothing to write: no event, so nothing is logged (both paths)', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(4);
      fake.unread = [];
      await run('UserPromptSubmit', ccv3);
      await run('UserPromptSubmit', nowhere);
      expect(logLines()).toEqual([]);
    });

    // B1: the timeout is a client-side timer, so the upsert may still commit on the server. The text must go out
    // anyway: the worst case is a message shown twice, never a message marked read and not shown.
    it('B1 board path, prompt page: the upsert throws, the text still holds the events and one line is logged', async () => {
      fake.failUpsert = true;
      fake.unread = [bc(101), dm(102)];
      const t = await run('UserPromptSubmit', ccv3);
      expect(tags(t)).toEqual(['bc101', 'dm102']);
      expect(inserts()).toHaveLength(1);
      const log = logLines();
      expect(log).toHaveLength(1);
      expect(log[0].error).toBe('Query read timeout');
      expect(log[0].event).toBe('UserPromptSubmit');
      expect(log[0].session).toBe(ME);
    });

    it('B1 no-board path: the upsert throws, the text still holds the direct message and one line is logged', async () => {
      fake.failUpsert = true;
      fake.unread = [dm(101)];
      const t = await run('UserPromptSubmit', nowhere);
      expect(tags(t)).toEqual(['dm101']);
      expect(inserts()).toHaveLength(1);
      const log = logLines();
      expect(log).toHaveLength(1);
      expect(log[0].error).toBe('Query read timeout');
    });

    it('B1 SessionStart: the upsert throws, the banner and the events are still returned', async () => {
      fake.failUpsert = true;
      fake.unread = [bc(101), dm(102)];
      const t = await run('SessionStart', ccv3);
      expect(t).toContain('## Lane board continuous-claude');
      expect(tags(t)).toEqual(['bc101', 'dm102']);
      expect(inserts()).toHaveLength(1);
      expect(logLines()).toHaveLength(1);
    });
  });
});

// Card coord-banner-dm-never-cut. G1: on SessionStart the header (up to 5,000 bytes) came BEFORE the direct messages, so a big
// header hid DMs behind "N more unread". Now, when DMs wait, the optional header sections (peers and their scopes, Claimable,
// Reminders) collapse to one line each and the page that shows strictly more whole DMs wins. G2: the more line names inbox
// whenever a DM waits. The 8,000-byte start budget stays. Seat conditions: the reserved lines never collapse; the page not chosen
// marks nothing read; with the same DM count the full header stays.
// Change that turns each row red: DMF1, DMF5, DMF8, DMF9: no second page (the full header always wins); DMF2: the collapse also drops a
// reserved line; DMF3 and DMF4: the collapse runs when it gains no DM; DMF5: the cursor follows the page that was not sent; DMF6 and
// DMF10 (G2): the cold more line names no inbox, or the plain inbox; DMF8: a DM shown cut counts as whole; DMF9: a DM cut alone does not
// open the second page.
describe('DMF: direct messages before the header (card coord-banner-dm-never-cut)', () => {
  const long = (p: string): string => `${p}-${'z'.repeat(70)}`;
  const held = (id: string, board = 'continuous-claude'): Row =>
    ({ id, title: 't', track: 'x', state: 'active', scope: 'RELATES TO: r-1, r-2, r-3', band: 'P1', project_key: board, owner_session_id: ME });
  /** The same hostile header as F9: over 5,000 bytes before any collapse. */
  const hostile = (): void => {
    fake.mine = [...Array.from({ length: 11 }, (_, i) => held(`my-${i + 1}`)), held(long('mylong')),
      held(long('far'), 'zz-board'), held('far-2', 'zz-board')];
    fake.lanes = [{ id: 'r-1', owner_session_id: PEER, reclaimable: false }];
    fake.peers = Array.from({ length: 10 }, (_, i) => ({
      sid: `bbbbbbbb-0000-4000-8000-00000000000${i}`,
      lanes: [`p${i}-a`, `p${i}-b`, long(`p${i}`), `p${i}-c`, `p${i}-d`].join(', '),
      scopes: 's'.repeat(2000), total: 14,
    }));
    const past = new Date(Date.now() - 3 * 3600_000).toISOString();
    fake.reminders = Array.from({ length: 5 }, (_, i) => ({
      id: i === 0 ? long('rem') : `rem-${i}`, title: 'r'.repeat(300), band: 'P1', due_at: past,
      remind_state: 'scheduled', action_id: null, total: 7,
    }));
    fake.claimable = Array.from({ length: 5 }, (_, i) => ({ id: i === 0 ? long('cl') : `cl-${i}`, title: 'c'.repeat(300), band: 'P2' }));
  };
  /** A header that stays whole under its 5,000-byte budget (4,117 bytes) and leaves the DMs about 3,700 bytes. Fully collapsed: 1,371 bytes. */
  const mid = (): void => { hostile(); fake.reminders = []; fake.claimable = fake.claimable.slice(0, 3); };
  const SCOPES = `     scopes: ${SHIM} board`;
  const dms = (n: number, size: number, wm: number | null = 100): Row[] =>
    Array.from({ length: n }, (_, i) => dm(101 + i, 'x'.repeat(size), wm));
  const moreLine = (t: string): string | undefined => t.split(NL).find((l) => /more unread/.test(l));

  it('DMF1: a 4,117-byte header and 5 DMs of 1,000 bytes: all 5 show whole, there is no more line, the text is within 8,000 bytes', async () => {
    mid();
    fake.unread = dms(5, 1000);
    const t = await run('SessionStart', ccv3);
    expect(tags(t)).toEqual(['dm101', 'dm102', 'dm103', 'dm104', 'dm105']);
    expect(moreLine(t)).toBeUndefined();
    expect(bytes(t), `text is ${bytes(t)} bytes`).toBeLessThanOrEqual(8000);
    expect(t).not.toContain('Lane text over its budget');
  });

  it('DMF2: the reserved lines never collapse when the header collapses: heading, You are, You hold, Milestone, Related, Commands', async () => {
    mid();
    fake.unread = dms(5, 1000);
    const lines = (await run('SessionStart', ccv3)).split(NL);
    expect(lines[0]).toBe('## Lane board continuous-claude (concurrent sessions on this board)');
    expect(lines).toContain('You are #aaaaaaaa.');
    expect(lines.some((l) => l.startsWith('You hold: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('Milestone ('))).toBe(true);
    expect(lines.some((l) => l.startsWith('Related: '))).toBe(true);
    expect(lines.some((l) => l.startsWith(`Commands: ${SHIM} board`))).toBe(true);
    // The optional sections are one line each and each names the command to read it in full.
    expect(lines).toContain(SCOPES);
    expect(lines).toContain(`Claimable (claim by id): ${SHIM} next`);
  });

  it('DMF3: the same DM count keeps the full header: 2 small DMs change no section', async () => {
    mid();
    fake.unread = dms(2, 200);
    const t = await run('SessionStart', ccv3);
    expect(tags(t)).toEqual(['dm101', 'dm102']);
    expect(t.split(NL).some((l) => l.startsWith('     scope: '))).toBe(true);
    expect(t).toContain('Claimable (claim by id):\n');
  });

  it('DMF4: no DM waiting (a board event only): the full header stays', async () => {
    mid();
    fake.unread = [bc(101, 'x'.repeat(200))];
    const t = await run('SessionStart', ccv3);
    expect(t.split(NL).some((l) => l.startsWith('     scope: '))).toBe(true);
    expect(t).toContain('Claimable (claim by id):\n');
  });

  it('DMF5: only the DMs of the page that was sent are marked read: 8 DMs of 1,000 bytes show a prefix, the cursor stops at its last DM', async () => {
    mid();
    fake.unread = dms(8, 1000);
    const t = await run('SessionStart', ccv3);
    const shown = tags(t);
    expect(shown.length, `shown ${shown.join(',')}`).toBeGreaterThan(3);
    expect(shown.length).toBeLessThan(8);
    expect(shown).toEqual(Array.from({ length: shown.length }, (_, i) => `dm${101 + i}`));
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params).toContain(100 + shown.length);
    expect(inserts()[0].params).not.toContain(108);
    // The rest wait behind one line that names the count and the inbox command.
    expect(moreLine(t)).toBe(`  (${8 - shown.length} more unread, ${8 - shown.length} direct to you. Later prompts show them, oldest first, or run: ${SHIM} inbox)`);
  });

  it('DMF7: a tie keeps the full header: a 9,000-byte DM shows alone (cut) under either header, so the collapse gains no DM', async () => {
    mid();
    fake.unread = [dm(101, 'x'.repeat(9000)), dm(102, 'short')];
    const t = await run('SessionStart', ccv3);
    expect(tags(t)).toEqual(['dm101']);
    expect(t.split(NL).some((l) => l.startsWith('     scope: '))).toBe(true);
    expect(t).toContain('Claimable (claim by id):\n');
  });

  it('DMF6: a cold board with 3 DMs of 3,000 bytes: the more line names the inbox command', async () => {
    fake.unread = dms(3, 3000, null);
    const t = await run('SessionStart', ccv3);
    expect(moreLine(t), t).toBeDefined();
    expect(moreLine(t)).toContain(`${SHIM} inbox`);
  });

  it('DMF8: two DMs of 5,000 bytes: the second page shows the first whole, not cut (critic F1: a cut DM is not a whole one)', async () => {
    mid();
    fake.unread = [dm(101, 'x'.repeat(5000), 100), dm(102, 'y'.repeat(5000), 100)];
    const t = await run('SessionStart', ccv3);
    expect(tags(t)).toEqual(['dm101']);
    expect(t).toContain('x'.repeat(5000));
    expect(t.split(NL).some((l) => l.startsWith('     scope: '))).toBe(false);
  });

  it('DMF9: ONE DM of 5,000 bytes, cut alone under the full header, shows whole when the header collapses (critic F4)', async () => {
    mid();
    fake.unread = [dm(101, 'x'.repeat(5000), 100)];
    const t = await run('SessionStart', ccv3);
    expect(tags(t)).toEqual(['dm101']);
    expect(t).toContain('x'.repeat(5000));
  });

  it('DMF10: a cold board names the read-only inbox --id of the oldest cut DM, never the plain inbox (critic F3)', async () => {
    fake.unread = dms(3, 3000, null);
    const t = await run('SessionStart', ccv3);
    const shown = tags(t).length;
    expect(moreLine(t), t).toBeDefined();
    expect(moreLine(t)).toContain(`${SHIM} inbox --id ${101 + shown}`);
    expect(moreLine(t)).not.toContain(`${SHIM} inbox)`);
  });
});
