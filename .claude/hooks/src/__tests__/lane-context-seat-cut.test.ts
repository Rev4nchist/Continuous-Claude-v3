/**
 * lane-context SEAT line (card coord-seat-label-and-cut-line, rule M4.17).
 *
 * The SessionStart banner starts with `SEAT: <label>`, the holder of the master card (lane `re-program`).
 * No holder, no line. The line is never cut, and it is SessionStart only.
 *
 * Ways it can fail:
 *   S1  the holder's label is missing, wrong, or not the first line of the text
 *   S2  a master card with no holder (or no master card) still prints a SEAT line
 *   S3  a header over its budget drops the SEAT line, or the start text passes 8,000 bytes
 *   S4  a very long session name makes the line long
 *   S5  the prompt path or the mid-turn path prints the SEAT line
 *
 * The database is a stub: it answers the master card lookup (by its `re-program` parameter) and nothing else.
 * The real SQL runs against the live table in the probe, not here.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

// A recording wrapper over fs: the CUT state write must go through a temp file and a rename. Everything else passes through.
const { fsLog, wrapFs } = vi.hoisted(() => {
  const log = { writes: [] as string[], renames: [] as Array<[string, string]>, failRename: false };
  const wrap = async (importOriginal: () => Promise<unknown>): Promise<Record<string, unknown>> => {
    const real = (await importOriginal()) as Record<string, unknown>;
    const writeFileSync = real.writeFileSync as (...a: unknown[]) => void;
    const renameSync = real.renameSync as (...a: unknown[]) => void;
    const over = {
      writeFileSync: (...a: unknown[]): void => { log.writes.push(String(a[0])); writeFileSync(...a); },
      renameSync: (...a: unknown[]): void => {
        log.renames.push([String(a[0]), String(a[1])]);
        if (log.failRename) throw new Error('EPERM: rename failed');
        renameSync(...a);
      },
    };
    return { ...real, ...over, default: { ...real, ...over } };
  };
  return { fsLog: log, wrapFs: wrap };
});
vi.mock('node:fs', wrapFs);
vi.mock('fs', wrapFs);

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] | undefined }>,
  failSeat: false,
  seat: [] as Row[],
  claimable: [] as Row[],
  peers: [] as Row[],
  unread: [] as Row[],
}));

vi.mock('pg', () => {
  class Client {
    on(): this { return this; }
    async connect(): Promise<void> { /* connected */ }
    async end(): Promise<void> { /* closed */ }
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      fake.calls.push({ sql, params });
      if (params?.includes('re-program')) {
        if (fake.failSeat) throw new Error('seat lookup failed');
        // Stands in for the WHERE clause: a query that names no project_key sees every board's re-program.
        const rows = fake.seat.filter((r) => !/project_key/.test(sql) || params.includes(r.project_key));
        return { rows };
      }
      if (/state IN \('ready','backlog'\)/.test(sql)) return { rows: fake.claimable };
      if (/FROM sessions s/.test(sql)) return { rows: fake.peers };
      if (/FROM agentic_os\.lane_event e\b/.test(sql)) return { rows: fake.unread };
      return { rows: [] };
    }
  }
  return { Client, default: { Client } };
});

import { RECLAIMABLE_SQL, deliverDirectMessages, dmStatePath, runLaneContext, utf8Bytes } from '../lane-context.js';
import { writeIdentity } from '../shared/session-identity.js';

const ME = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const BOSS = 'cccccccc-0000-4000-8000-0000000000c3';
const PEER = 'bbbbbbbb-0000-4000-8000-0000000000b2';

let tmp: string;
let ccv3: string;
const keys = ['LANE_REGISTRY_PATH', 'DATABASE_URL', 'CONTINUOUS_CLAUDE_DB_URL', 'CCV3_IDENTITY_DIR', 'CCV3_USER_HOME',
  'LANE_BOARD_CACHE', 'LANE_CONTEXT_ERROR_LOG', 'CLAUDE_CODE_ENTRYPOINT', 'LANE_CONTEXT_HEADLESS',
  'LANE_CUT_STATE_DIR', 'TEMP', 'TMP', 'TMPDIR'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of keys) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'lc-seat-'));
  ccv3 = join(tmp, 'ccv3');
  mkdirSync(ccv3, { recursive: true });
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
  process.env.LANE_CUT_STATE_DIR = join(tmp, 'cut-state');
  // The hook's throttle and cache files go to os.tmpdir(): give each test its own, so no test shares a file with another.
  const osTmp = join(tmp, 'os-tmp');
  mkdirSync(osTmp, { recursive: true });
  process.env.TEMP = osTmp; process.env.TMP = osTmp; process.env.TMPDIR = osTmp;
  fsLog.writes.length = 0; fsLog.renames.length = 0; fsLog.failRename = false;
  fake.failSeat = false;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.LANE_CONTEXT_HEADLESS;
  fake.calls.length = 0;
  fake.seat = []; fake.claimable = []; fake.peers = []; fake.unread = [];
  vi.spyOn(process, 'uptime').mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

/** A re-program row as the database returns it: the holder, the board it belongs to, and the reclaim test result. */
const seatRow = (owner: string | null, o: { board?: string; reclaimable?: boolean } = {}): Row => ({
  owner_session_id: owner, project_key: o.board ?? 'continuous-claude', reclaimable: o.reclaimable ?? false,
});

type Out ={ hookSpecificOutput?: { additionalContext: string } };
const run = async (event: string, opts?: Parameters<typeof runLaneContext>[1]): Promise<string> =>
  ((await runLaneContext(JSON.stringify({ session_id: ME, hook_event_name: event, cwd: ccv3 }), opts)) as Out)
    .hookSpecificOutput?.additionalContext ?? '';

describe('SEAT', () => {
  it('S1: the first line of the SessionStart text is SEAT: <name> #<sid8> of the master card holder', async () => {
    writeIdentity(BOSS, { name: 'trex' });
    fake.seat = [seatRow(BOSS)];
    const text = await run('SessionStart');
    expect(text.split('\n')[0]).toBe('SEAT: trex #cccccccc');
    expect(text).toContain('## Lane board continuous-claude');
    expect(fake.calls.some((c) => c.params?.includes('re-program'))).toBe(true);
  });

  it('S2: no holder, or no master card, gives no SEAT line', async () => {
    for (const rows of [[seatRow(null)], []]) {
      fake.seat = rows;
      const text = await run('SessionStart');
      expect(text).not.toContain('SEAT:');
      expect(text.split('\n')[0]).toBe('## Lane board continuous-claude (concurrent sessions on this board)');
    }
  });

  it('S3: a header over its budget keeps the SEAT line, and the start text stays within 8,000 bytes', async () => {
    writeIdentity(BOSS, { name: 'trex' });
    fake.seat = [seatRow(BOSS)];
    fake.claimable = ['one', 'two', 'three'].map((id) => ({ id: `card-${id}`, title: `Title of ${id}`, band: null }));
    fake.peers = [{ sid: PEER, lanes: 'lane-x', scopes: 'src/'.repeat(400), total: 1 }];
    const text = await run('SessionStart', { budgets: { header: 700 } });
    // The header was over its budget: the Claimable block is its one-line form.
    expect(text).toMatch(/Claimable \(claim by id\): node .* next/);
    expect(text).not.toContain('Title of one');
    expect(text.split('\n')[0]).toBe('SEAT: trex #cccccccc');
    expect(text).toContain('You are #aaaaaaaa.');
    expect(utf8Bytes(text)).toBeLessThanOrEqual(8000);
  });

  it('S4: a very long session name is clipped, so the line stays within 80 bytes and keeps the sid', async () => {
    for (const name of ['n'.repeat(300), '\u20AC'.repeat(300), '\u{1F600}'.repeat(300)]) {
      writeIdentity(BOSS, { name });
      fake.seat = [seatRow(BOSS)];
      const line = (await run('SessionStart')).split('\n')[0];
      expect(line.startsWith('SEAT: ')).toBe(true);
      expect(line.endsWith(' #cccccccc')).toBe(true);
      expect(utf8Bytes(line)).toBeLessThanOrEqual(80);
    }
  });

  it('S6: a re-program lane of another board gives no SEAT line; the lane of this board still does', async () => {
    writeIdentity(BOSS, { name: 'trex' });
    fake.seat = [seatRow(PEER, { board: 'other-board' })];
    const other = await run('SessionStart');
    expect(other).not.toContain('SEAT:');
    expect(other.split('\n')[0]).toContain('## Lane board continuous-claude');

    fake.seat = [seatRow(PEER, { board: 'other-board' }), seatRow(BOSS)];
    expect((await run('SessionStart')).split('\n')[0]).toBe('SEAT: trex #cccccccc');
    const q = fake.calls.find((c) => c.params?.includes('re-program'));
    expect(q?.params).toContain('continuous-claude');
  });

  it('S7: a holder whose lease ended and who is quiet gives no SEAT line; a live holder gives it', async () => {
    writeIdentity(BOSS, { name: 'trex' });
    fake.seat = [seatRow(BOSS, { reclaimable: true })];
    const gone = await run('SessionStart');
    expect(gone).not.toContain('SEAT:');
    expect(gone.split('\n')[0]).toContain('## Lane board continuous-claude');

    fake.seat = [seatRow(BOSS, { reclaimable: false })];
    expect((await run('SessionStart')).split('\n')[0]).toBe('SEAT: trex #cccccccc');
    // The test is the shared reclaim test of the Related line, not a second copy.
    expect(fake.calls.find((c) => c.params?.includes('re-program'))?.sql).toContain(RECLAIMABLE_SQL);
  });

  it('S8: control characters in the holder name never reach the line: it stays one line', async () => {
    fake.seat = [seatRow(BOSS)];
    for (const name of ['ev\u001b[31mil', 'two\nlines', 'nul\u0000x\u007fy', 'bell\u0007\u0008end']) {
      writeIdentity(BOSS, { name });
      const lines = (await run('SessionStart')).split('\n');
      expect(lines[0], name).toMatch(/^SEAT: [^\u0000-\u001f\u007f]+ #cccccccc$/);
      expect(lines[1]).toContain('## Lane board continuous-claude');
    }
  });

  it('S9: a failing SEAT lookup drops the line only: the rest of the text is the same, and nothing crashes', async () => {
    fake.seat = [];
    const base = await run('SessionStart');
    writeIdentity(BOSS, { name: 'trex' });
    fake.seat = [seatRow(BOSS)];
    fake.failSeat = true;
    const text = await run('SessionStart');
    expect(text).not.toContain('SEAT:');
    expect(text).toBe(base);
  });

  it('S5: the prompt path and the mid-turn path print no SEAT line', async () => {
    writeIdentity(BOSS, { name: 'trex' });
    fake.seat = [seatRow(BOSS)];
    fake.unread = [{
      id: 5, occurred_at: '', lane_id: null, kind: 'note', session_id: PEER, to_session_id: ME,
      body: 'hello', project_key: 'continuous-claude', board_wm: 1,
    }];
    const prompt = await run('UserPromptSubmit');
    expect(prompt).toContain('hello');
    expect(prompt).not.toContain('SEAT:');

    const sid = `test-seat-${process.pid}`;
    const emitFn = vi.fn();
    try {
      await deliverDirectMessages(sid, Date.now(), emitFn);
    } finally {
      rmSync(dmStatePath(sid), { force: true });
    }
    expect(emitFn).toHaveBeenCalledTimes(1);
    const mid = String(emitFn.mock.calls[0][0]);
    expect(mid).toContain('hello');
    expect(mid).not.toContain('SEAT:');
  });
});

/**
 * The CUT, NOT READ line. When a page cuts an event body, the id is kept in a state file of its own
 * (LANE_CUT_STATE_DIR/<session id>.json). Each later board text starts (after SEAT) with
 * `CUT, NOT READ: <id> ...` for each id printed fewer than 3 times and kept less than 30 minutes.
 *
 * Ways it can fail:
 *   C1  a cut id does not show on the next text, or shows on the text that cut it
 *   C2  an id stays after its 3rd print (or goes before it)
 *   C3  an id stays after 30 minutes (or goes before)
 *   C4  an over-budget header drops the line; a fallback text prints it or counts a print
 *   C5  a line shows when nothing was cut
 *   C6  more than 8 ids print; ids that did not print are counted
 *   C7  the mid-turn text prints it
 *   C8  a corrupt or unreadable state file crashes the hook or prints a line
 */
describe('CUT', () => {
  const T0 = 1_700_000_000_000;
  const MIN = 60_000;
  const at = (ms: number): { now: () => number } => ({ now: () => T0 + ms });
  const CUT_RE = /^CUT, NOT READ: /;
  const cutLineOf = (t: string): string | undefined => t.split('\n').find((l) => CUT_RE.test(l));
  const hasCut = (t: string): boolean => t.includes('more bytes. Full text');
  const cutFile = (): string => join(process.env.LANE_CUT_STATE_DIR as string, `${ME}.json`);
  const big = (id: number): Row => ({
    id, occurred_at: '', lane_id: null, kind: 'note', session_id: PEER, to_session_id: null,
    body: 'x'.repeat(9000), project_key: 'continuous-claude', board_wm: 1,
  });
  const small = (id: number): Row => ({ ...big(id), body: 'short' });

  /** One prompt page that cuts the body of event `id`, at time `ms`. Returns that page's text. */
  async function cutIt(id: number, ms = 0): Promise<string> {
    fake.unread = [big(id)];
    const text = await run('UserPromptSubmit', at(ms));
    fake.unread = [];
    expect(text, 'the event body was not cut').toContain('more bytes. Full text');
    return text;
  }

  it('C1: a cut id shows on the NEXT text, right after the SEAT line, and not on the text that cut it', async () => {
    writeIdentity(BOSS, { name: 'trex' });
    fake.seat = [seatRow(BOSS)];
    const cutPage = await cutIt(41);
    expect(cutLineOf(cutPage)).toBeUndefined();

    const start = (await run('SessionStart', at(MIN))).split('\n');
    expect(start[0]).toBe('SEAT: trex #cccccccc');
    expect(start[1]).toBe('CUT, NOT READ: 41');
    expect(start[2]).toContain('## Lane board continuous-claude');
  });

  it('C1: the prompt page shows it first when the page has other text; no SEAT line there', async () => {
    fake.seat = [seatRow(BOSS)];
    await cutIt(41);
    fake.unread = [small(42)];
    const page = await run('UserPromptSubmit', at(MIN));
    expect(page.split('\n')[0]).toBe('CUT, NOT READ: 41');
    expect(page).toContain('short');
    expect(page).not.toContain('SEAT:');
  });

  it('C2: the id leaves after its 3rd print', async () => {
    await cutIt(41);
    for (let i = 1; i <= 3; i += 1) {
      expect(cutLineOf(await run('SessionStart', at(i * MIN))), `print ${i}`).toBe('CUT, NOT READ: 41');
    }
    expect(cutLineOf(await run('SessionStart', at(4 * MIN)))).toBeUndefined();
  });

  it('C3: the id leaves 30 minutes after the cut, even with fewer than 3 prints', async () => {
    await cutIt(41);
    expect(cutLineOf(await run('SessionStart', at(30 * MIN - 1)))).toBe('CUT, NOT READ: 41');
    expect(cutLineOf(await run('SessionStart', at(30 * MIN)))).toBeUndefined();
  });

  it('C4: an over-budget header keeps SEAT and CUT as its first lines, and the text stays within 8,000 bytes', async () => {
    writeIdentity(BOSS, { name: 'trex' });
    fake.seat = [seatRow(BOSS)];
    fake.claimable = ['one', 'two', 'three'].map((id) => ({ id: `card-${id}`, title: `Title of ${id}`, band: null }));
    fake.peers = [{ sid: PEER, lanes: 'lane-x', scopes: 'src/'.repeat(400), total: 1 }];
    await cutIt(41);
    const text = await run('SessionStart', { budgets: { header: 700 }, ...at(MIN) });
    expect(text).toMatch(/Claimable \(claim by id\): node .* next/);
    const lines = text.split('\n');
    expect(lines[0]).toBe('SEAT: trex #cccccccc');
    expect(lines[1]).toBe('CUT, NOT READ: 41');
    expect(utf8Bytes(text)).toBeLessThanOrEqual(8000);
  });

  it('C4: a text over its budget falls back with no CUT line, and counts no print', async () => {
    await cutIt(41);
    const fallback = await run('SessionStart', { budgets: { start: 60 }, ...at(MIN) });
    expect(fallback).toContain('Lane text over its budget');
    expect(cutLineOf(fallback)).toBeUndefined();
    for (let i = 2; i <= 4; i += 1) {
      expect(cutLineOf(await run('SessionStart', at(i * MIN))), `print ${i}`).toBe('CUT, NOT READ: 41');
    }
    expect(cutLineOf(await run('SessionStart', at(5 * MIN)))).toBeUndefined();
  });

  it('C5: no line when nothing was cut, and a whole event does not count as cut', async () => {
    expect(cutLineOf(await run('SessionStart', at(0)))).toBeUndefined();
    fake.unread = [small(7)];
    const page = await run('UserPromptSubmit', at(MIN));
    expect(page).toContain('short');
    expect(cutLineOf(page)).toBeUndefined();
    fake.unread = [];
    expect(cutLineOf(await run('SessionStart', at(2 * MIN)))).toBeUndefined();
  });

  it('C6: at most 8 ids print, then +N more; ids that did not print keep their prints', async () => {
    // One page cuts 11 bodies (a later prompt page would count prints for the ids already kept).
    fake.unread = Array.from({ length: 11 }, (_, i) => big(101 + i));
    const cutPage = await run('UserPromptSubmit', at(0));
    expect(cutPage.match(/more bytes\. Full text/g)).toHaveLength(11);
    fake.unread = [];
    const line = cutLineOf(await run('SessionStart', at(MIN))) as string;
    expect(line).toBe('CUT, NOT READ: 101 102 103 104 105 106 107 108 +3 more');
    expect(utf8Bytes(line)).toBeLessThanOrEqual(100);
    await run('SessionStart', at(2 * MIN));
    await run('SessionStart', at(3 * MIN));
    expect(cutLineOf(await run('SessionStart', at(4 * MIN)))).toBe('CUT, NOT READ: 109 110 111');
  });

  it('C7: the mid-turn text never prints the line', async () => {
    await cutIt(41);
    fake.unread = [{ ...small(9), to_session_id: ME }];
    const emitFn = vi.fn();
    try {
      await deliverDirectMessages(ME, Date.now(), emitFn);
    } finally {
      rmSync(dmStatePath(ME), { force: true });
    }
    expect(emitFn).toHaveBeenCalledTimes(1);
    expect(String(emitFn.mock.calls[0][0])).toContain('short');
    expect(String(emitFn.mock.calls[0][0])).not.toContain('CUT, NOT READ');
    // The mid-turn text counted no print: the id still prints 3 more times, and is gone on the 4th.
    fake.unread = [];
    for (let i = 1; i <= 3; i += 1) {
      expect(cutLineOf(await run('SessionStart', at(i * MIN))), `print ${i}`).toBe('CUT, NOT READ: 41');
    }
    expect(cutLineOf(await run('SessionStart', at(4 * MIN)))).toBeUndefined();
  });

  it('C8: a corrupt state file gives no line and no crash; the banner still prints', async () => {
    await cutIt(41);
    writeFileSync(cutFile(), '{not json', 'utf8');
    const text = await run('SessionStart', at(MIN));
    expect(cutLineOf(text)).toBeUndefined();
    expect(text.split('\n')[0]).toContain('## Lane board continuous-claude');
  });

  it('C8: an unreadable state file (a folder in its place) gives no line and no crash', async () => {
    await cutIt(41);
    rmSync(cutFile(), { force: true });
    mkdirSync(cutFile(), { recursive: true });
    const text = await run('SessionStart', at(MIN));
    expect(cutLineOf(text)).toBeUndefined();
    expect(text.split('\n')[0]).toContain('## Lane board continuous-claude');
  });

  it('C9: a late page (the hook is old) sends its text but counts no print and records no cut', async () => {
    await cutIt(41);
    const late = await run('SessionStart', { uptime: () => 5, ...at(MIN) });
    expect(cutLineOf(late)).toBe('CUT, NOT READ: 41');
    // A late prompt page that cuts a new event records nothing either.
    fake.unread = [big(77)];
    const latePrompt = await run('UserPromptSubmit', { uptime: () => 5, ...at(MIN) });
    expect(hasCut(latePrompt)).toBe(true);
    fake.unread = [];
    for (let i = 2; i <= 4; i += 1) {
      expect(cutLineOf(await run('SessionStart', at(i * MIN))), `print ${i}`).toBe('CUT, NOT READ: 41');
    }
    expect(cutLineOf(await run('SessionStart', at(5 * MIN)))).toBeUndefined();
  });

  it('C10: the state is written to a temp file in its own folder, then renamed over the state file', async () => {
    await cutIt(41);
    expect(fsLog.writes).not.toContain(cutFile());
    const toState = fsLog.renames.filter(([, to]) => to === cutFile());
    expect(toState).toHaveLength(1);
    const [from] = toState[0];
    expect(from).not.toBe(cutFile());
    expect(dirname(from)).toBe(dirname(cutFile()));
    expect(fsLog.writes).toContain(from);
  });

  it('C10: a rename that fails leaves the old state file intact, no temp file, and the banner unchanged', async () => {
    await cutIt(41);
    const before = readFileSync(cutFile(), 'utf8');
    fsLog.failRename = true;
    await cutIt(42, MIN);
    fsLog.failRename = false;
    expect(readFileSync(cutFile(), 'utf8')).toBe(before);
    expect(readdirSync(dirname(cutFile()))).toEqual([basename(cutFile())]);
    expect(cutLineOf(await run('SessionStart', at(2 * MIN)))).toBe('CUT, NOT READ: 41');
  });

  it('C11: a state folder that cannot be written drops the line only: the text is the same, and nothing crashes', async () => {
    const base = await run('SessionStart', at(0));
    const blocker = join(tmp, 'a-file');
    writeFileSync(blocker, 'x');
    process.env.LANE_CUT_STATE_DIR = join(blocker, 'sub'); // mkdir under a regular file fails
    await cutIt(41);
    expect(await run('SessionStart', at(MIN))).toBe(base);
  });

  it('C12: a state file with prints below 0 or an `at` in the future is not read', async () => {
    mkdirSync(dirname(cutFile()), { recursive: true });
    writeFileSync(cutFile(), JSON.stringify({ entries: [
      { id: 41, at: T0, prints: 0 },
      { id: 42, at: T0, prints: -5 },
      { id: 43, at: T0 + 10 * MIN, prints: 0 },
    ] }), 'utf8');
    expect(cutLineOf(await run('SessionStart', at(MIN)))).toBe('CUT, NOT READ: 41');
  });

  it('C13: a text that prints no pending id and cuts nothing does not touch the state file', async () => {
    await cutIt(41);
    fsLog.writes.length = 0; fsLog.renames.length = 0;
    fake.unread = [];
    await run('UserPromptSubmit', at(MIN)); // no unread: the prompt path is silent, so no print
    await run('SessionStart', at(MIN)); // with nothing pending after expiry: nothing to change
    const stateWrites = [...fsLog.writes, ...fsLog.renames.map(([, to]) => to)].filter((p) => p.includes('cut-state'));
    // The SessionStart print is a change (one write); the silent prompt is not.
    expect(stateWrites.filter((p) => p === cutFile())).toHaveLength(1);
  });
});
