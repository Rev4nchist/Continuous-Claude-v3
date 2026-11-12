/**
 * lane-board-stop-gate: blocks the end of a turn once per batch until the board page is published.
 *
 * Failure list, one test (or group) each:
 *   S1  a pending file for a board with a phone page does not block (or a board with none does)
 *       The default board's page comes from artifacts.json. Another board has a page only when its own registry
 *       entry carries `laneArtifact` (Option B); with none, a file for that board never blocks.
 *   S2  <sid>@<board>.json is not seen (only the bare <sid>.json is read)
 *   S3  the block repeats inside one batch (stopBlocked not written), or a second board's batch is hidden by the first
 *   S4  a headless run, a stop_hook_active continuation, or no session id blocks
 *   S5  the reason names the CCv3 url for another board (or a relative render command)
 *   S6  a stale pending file (older than 24 h) stays forever, or another session's file blocks this one
 *   S7  the reminder and the gate disagree on the file name
 *
 * Publish budget (lane board-publish-budget, spec .claudedocs/e2e-board-publish-budget/spec.md). One test per id:
 *   G1  a say-only batch blocks                              G12 another board's foreign file blocks (KEEP)
 *   G2  an ask verb no longer blocks (KEEP)                  G13 a foreign say-only file blocks (KEEP)
 *   G3  a block inside 10 minutes of a publish               G14 a corrupt budget file changes the decision or is deleted
 *   G4  no block after the window, or no `asked` stamp       G15 a budget folder that is a file throws or blocks
 *   G5  a change the page already shows blocks               G16 a .tmp budget file is read (KEEP)
 *   G6  a block inside 10 minutes of another session's ask   G17 the 24 h sweep deletes the budget folder (KEEP)
 *   G7  a block at 150 publishes of the UTC day              G18 the reason text lacks `file. 2.` or the limit sentence
 *   G8  yesterday's count stops the ask (KEEP)               G19 two sessions block at the same clock
 *   G9  a block after a daily-limit refusal                  G20 a 50-verb file with no ask verb does not block (KEEP)
 *   G10 another session's old change is never asked          G21 an id that is not a uuid writes a budget file (KEEP)
 *   G11 a foreign change inside 10 minutes blocks (KEEP)     G22 a headless run reads or writes the budget (KEEP)
 * KEEP = the test passes on main too: it pins behaviour the change must not lose.
 * The budget tests use a fixed clock (NOW) and set every file time with utimesSync.
 *
 * Review fixes (describe "review fixes"), one id per reported defect. PIN = a test gap: the test is green on
 * correct code and red under the named change.
 *   F1  another session's 50 say with no ask verb is asked, again after each say
 *   F2  an old-shape claim that a publish covers is asked again after one say (the say moved the mtime)
 *   F3  one failed rename (EPERM while a reader has the file open) loses the write
 *   F4  two writers of one budget file both report success and one update is lost
 *   F5  a stamp a few ms later than the reader's clock is dropped; an earlier clock erases it or today's count
 *   F6  a headless run that opted in takes the one foreign ask and cannot publish
 *   F8  PIN the window is 10 minutes: red with 6 minutes or 10.9 minutes
 *   F9  PIN the day is the UTC day: red with the local date (in a time zone 2 hours or more from UTC)
 *   F11 the reason says "publish again" for every refusal, then "do not publish again" for the daily limit
 *   F12 PIN the dot-file filter: red when foreignPending reads `.render-*.json`
 *   F13 PIN the budget write goes through a .tmp file and one rename: red with a direct write
 * F7 is lane-board-reminder-boards.test.ts. F10, F14 and F15 have no test (decisions for the seat or the parent).
 */
import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as gate from '../lane-board-stop-gate.js';
import * as reminder from '../lane-board-republish-reminder.js';
import { renderBoardCmd } from '../shared/lane-board.js';

const ENV_INTERACTIVE = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const ENV_HEADLESS = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };
const payload = (extra: Record<string, unknown> = {}) => ({ session_id: 'sess-1', hook_event_name: 'Stop', ...extra });
const CCV3 = { board: 'continuous-claude', pending: {} };
const PH = { board: 'ph-board', pending: {} };
const ZZ = { board: 'zz-board', pending: {} };
const PH_URL = 'https://claude.ai/artifact/KaD7X6HnLKHKjzz7cecUVF';

let tmp = '';
let dir = '';
let home = '';
let registry = '';
const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...ENV_INTERACTIVE, LANE_BOARD_PENDING_DIR: dir, CCV3_USER_HOME: home, LANE_REGISTRY_PATH: registry,
  // A block reads the FleetOps state dir. Keep it in the temp folder, never the live ~/.claude/state.
  LANE_DASH_STATE_DIR: path.join(tmp, 'lane-dash'), ...extra,
});
/** Write the temp registry: ph-board gets the given extra fields (a laneArtifact by default), zz-board has none. */
const writeRegistry = (ph: Record<string, unknown> = { laneArtifact: PH_URL }): void => {
  fs.writeFileSync(registry, JSON.stringify({ projects: [
    { name: 'CCv3', key: 'continuous-claude', path: path.join(tmp, 'ccv3'), status: 'active' },
    { name: 'PH', key: 'ph-board', path: path.join(tmp, 'ph'), status: 'active', ...ph },
    { name: 'ZZ', key: 'zz-board', path: path.join(tmp, 'zz'), status: 'active' },
  ] }));
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stopgate-'));
  dir = path.join(tmp, 'pending');
  home = path.join(tmp, 'home');
  registry = path.join(tmp, 'registry.json');
  writeRegistry();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, 'continuous-claude', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, 'continuous-claude', '.claude', 'artifacts.json'), JSON.stringify({ artifacts: [
    { id: 'agentic-os-lane-board', url: 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid', publish_from: 'lane-board.html' },
    { id: 'other-page', url: 'https://claude.ai/artifact/PHPHPH1', publish_from: 'other.html' },
  ] }));
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/**
 * Make fs.renameSync fail the first `times` calls with `code`, then work. The hook imports `* as fs`, a
 * read-only namespace that vi.spyOn cannot change, so the swap is made on the CommonJS `fs` object and
 * syncBuiltinESMExports() carries it to the namespace. Call restore() in a finally.
 */
const fsCjs = createRequire(import.meta.url)('fs') as typeof fs;
const realRename = fsCjs.renameSync;
function failRename(times: number, code = 'EPERM'): { calls: Array<[string, string]>; restore: () => void } {
  const calls: Array<[string, string]> = [];
  fsCjs.renameSync = ((from: fs.PathLike, to: fs.PathLike): void => {
    calls.push([String(from), String(to)]);
    if (calls.length <= times) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
    realRename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  return { calls, restore: () => { fsCjs.renameSync = realRename; syncBuiltinESMExports(); } };
}
afterEach(() => { fsCjs.renameSync = realRename; syncBuiltinESMExports(); });

describe('decideStop (pure)', () => {
  it('approves a non-object payload', () => {
    expect(gate.decideStop(null, ENV_INTERACTIVE, [CCV3]).action).toBe('approve');
    expect(gate.decideStop('x', ENV_INTERACTIVE, [CCV3]).action).toBe('approve');
  });

  it('S4: approves when Claude Code is already continuing because of a Stop hook', () => {
    expect(gate.decideStop(payload({ stop_hook_active: true }), baseEnv(), [CCV3]).action).toBe('approve');
  });

  it('S4: approves a headless run even with a pending file', () => {
    expect(gate.decideStop(payload(), baseEnv(ENV_HEADLESS), [CCV3]).action).toBe('approve');
  });

  it('S4: blocks a headless run that opted in with LANE_CONTEXT_HEADLESS=1', () => {
    expect(gate.decideStop(payload(), baseEnv({ ...ENV_HEADLESS, LANE_CONTEXT_HEADLESS: '1' }), [CCV3]).action).toBe('block');
  });

  it('S4: approves with no session id', () => {
    expect(gate.decideStop({ hook_event_name: 'Stop' }, baseEnv(), [CCV3]).action).toBe('approve');
    expect(gate.decideStop(payload({ session_id: '' }), baseEnv(), [CCV3]).action).toBe('approve');
  });

  it('approves when nothing is pending', () => {
    expect(gate.decideStop(payload(), baseEnv(), []).action).toBe('approve');
  });

  it('S3: approves when every batch was already blocked once', () => {
    expect(gate.decideStop(payload(), baseEnv(), [{ board: 'continuous-claude', pending: { stopBlocked: true } }]).action).toBe('approve');
  });

  it('S1: approves a pending file whose board has no phone page', () => {
    expect(gate.decideStop(payload(), baseEnv(), [ZZ]).action).toBe('approve');
  });

  it('S3: skips a blocked batch and a board with no page, blocks the next batch that has a page', () => {
    const none = gate.decideStop(payload(), baseEnv(), [
      { board: 'continuous-claude', pending: { stopBlocked: true } },
      ZZ,
      { board: 'ph-board', pending: { stopBlocked: true } },
    ]);
    expect(none.action).toBe('approve');
    const d = gate.decideStop(payload(), baseEnv(), [ZZ, PH, CCV3]);
    expect(d.action).toBe('block');
    if (d.action === 'block') expect(d.board).toBe('ph-board');
    const d2 = gate.decideStop(payload(), baseEnv(), [ZZ, { board: 'ph-board', pending: { stopBlocked: true } }, CCV3]);
    expect(d2.action).toBe('block');
    if (d2.action === 'block') expect(d2.board).toBe('continuous-claude');
  });

  it('S1: a board with a laneArtifact blocks and names its own page file and its rebuilt url', () => {
    const d = gate.decideStop(payload(), baseEnv(), [PH]);
    expect(d.action).toBe('block');
    if (d.action === 'block') {
      expect(d.board).toBe('ph-board');
      expect(d.reason).toContain('lane-board-ph-board.html');
      expect(d.reason).toContain(PH_URL);
      expect(d.reason).toContain(renderBoardCmd('ph-board', baseEnv()));
      expect(d.reason).not.toContain('RtrTNVfAq9uowmb2tfbzid');
    }
  });

  it('S1: the same board without a laneArtifact approves', () => {
    writeRegistry({});
    expect(gate.decideStop(payload(), baseEnv(), [PH]).action).toBe('approve');
  });

  it('S1: a laneArtifact with a bad url, or the default board id, approves', () => {
    for (const bad of ['https://evil.example/artifact/x', 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid']) {
      writeRegistry({ laneArtifact: bad });
      expect(gate.decideStop(payload(), baseEnv(), [PH]).action).toBe('approve');
    }
  });

  it('S5: the reason names the CCv3 url and the absolute render command', () => {
    const d = gate.decideStop(payload(), baseEnv(), [CCV3]);
    expect(d.action).toBe('block');
    if (d.action === 'block') {
      expect(d.reason).toContain(renderBoardCmd('continuous-claude', baseEnv()));
      expect(d.reason).toContain('https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid');
      expect(d.reason).not.toContain('node scripts/coordination');
      expect(d.reason).toContain('omit capabilities');
    }
  });

  it('S6: the reason says to read the live page before the render and the publish, and a refusal retries the same file', () => {
    const d = gate.decideStop(payload(), baseEnv(), [CCV3]);
    expect(d.action).toBe('block');
    if (d.action === 'block') {
      const read = d.reason.indexOf('action read');
      expect(read).toBeGreaterThan(-1);
      expect(read).toBeLessThan(d.reason.indexOf(renderBoardCmd('continuous-claude', baseEnv())));
      expect(d.reason.indexOf(renderBoardCmd('continuous-claude', baseEnv()))).toBeLessThan(d.reason.indexOf('publish '));
      expect(d.reason).toContain('without path');
      expect(d.reason).toContain('publish the same file again');
      expect(d.reason).not.toContain('render again');
    }
  });
});

describe('stopGate (reads and writes the pending dir)', () => {
  const put = (name: string, body: object, ageMs = 0) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, JSON.stringify(body));
    if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(f, t, t); }
    return f;
  };
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

  it('S2: blocks on the default board file once per batch', () => {
    put('sess-1.json', { since: 'x', verbs: ['claim'], board: 'continuous-claude' });
    const first = gate.stopGate(payload(), baseEnv());
    expect(first.output).toMatchObject({ decision: 'block' });
    expect(read('sess-1.json').stopBlocked).toBe(true);
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
  });

  it('S1: a <sid>@<board>.json file for a board with a laneArtifact blocks once and is marked', () => {
    put('sess-1@ph-board.json', { since: 'x', verbs: ['claim'], board: 'ph-board' });
    const first = gate.stopGate(payload(), baseEnv());
    expect(JSON.stringify(first.output)).toContain('lane-board-ph-board.html');
    expect(JSON.stringify(first.output)).toContain(PH_URL);
    expect(read('sess-1@ph-board.json').stopBlocked).toBe(true);
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
  });

  it('S1: a <sid>@<board>.json file never blocks when the registry gives that board no page, and is not marked', () => {
    writeRegistry({});
    put('sess-1@ph-board.json', { since: 'x', verbs: ['claim'], board: 'ph-board' });
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
    expect(read('sess-1@ph-board.json').stopBlocked).toBeUndefined();
  });

  it('S1: approves a file for a board with no phone page', () => {
    put('sess-1@zz-board.json', { since: 'x', verbs: ['claim'], board: 'zz-board' });
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
    expect(read('sess-1@zz-board.json').stopBlocked).toBeUndefined();
  });

  // Fixtures below use the ask verb `claim`: a note-only batch no longer asks for a publish (G1).
  it('S2: an old PR0 file (<sid>.json, no board field) is the CCv3 batch', () => {
    put('sess-1.json', { since: 'x', verbs: ['claim'] });
    const r = gate.stopGate(payload(), baseEnv());
    expect(JSON.stringify(r.output)).toContain('RtrTNVfAq9uowmb2tfbzid');
  });

  it('S3: two boards with pages pending: each blocks once (file-name order), then the gate approves', () => {
    put('sess-1.json', { since: 'x', verbs: ['claim'], board: 'continuous-claude' });
    put('sess-1@ph-board.json', { since: 'x', verbs: ['claim'], board: 'ph-board' });
    expect(JSON.stringify(gate.stopGate(payload(), baseEnv()).output)).toContain('RtrTNVfAq9uowmb2tfbzid');
    expect(JSON.stringify(gate.stopGate(payload(), baseEnv()).output)).toContain('lane-board-ph-board.html');
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
  });

  it('S3: a board with no page never blocks next to the default board batch', () => {
    put('sess-1.json', { since: 'x', verbs: ['claim'], board: 'continuous-claude' });
    put('sess-1@zz-board.json', { since: 'x', verbs: ['claim'], board: 'zz-board' });
    expect(JSON.stringify(gate.stopGate(payload(), baseEnv()).output)).toContain('RtrTNVfAq9uowmb2tfbzid');
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
    expect(read('sess-1@zz-board.json').stopBlocked).toBeUndefined();
  });

  it('S4: a headless run approves and does not mark the batch', () => {
    put('sess-1.json', { since: 'x', verbs: ['claim'] });
    expect(gate.stopGate(payload(), baseEnv(ENV_HEADLESS)).output).toBeNull();
    expect(read('sess-1.json').stopBlocked).toBeUndefined();
  });

  it('S6: a fresh file of another session never blocks this session', () => {
    put('sess-2.json', { since: 'x', verbs: ['claim'] });
    put('sess-12.json', { since: 'x', verbs: ['claim'] });
    put('sess-1x@ph-board.json', { since: 'x', verbs: ['claim'], board: 'ph-board' });
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
  });

  it('S6: a pending file older than 24 h is deleted; a fresh one stays', () => {
    const old = put('sess-9.json', { since: 'x', verbs: ['note'] }, 25 * 3600_000);
    const fresh = put('sess-8.json', { since: 'x', verbs: ['note'] }, 23 * 3600_000);
    gate.stopGate(payload(), baseEnv());
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('S6: this session\'s own stale file is deleted, not used for a block', () => {
    put('sess-1.json', { since: 'x', verbs: ['claim'] }, 30 * 3600_000);
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
  });

  it('a missing dir approves', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
  });
});

describe('publish budget (stopGate with a fixed clock)', () => {
  const NOW = Date.UTC(2026, 10, 12, 15, 0, 0); // mid-day UTC: "minutes ago" stays inside one UTC day
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const TODAY = '2026-11-12';
  const YESTERDAY = '2026-11-11';
  const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
  const SID_B = 'bbbbbbbb-0000-4000-8000-000000000002';
  const SID_C = 'cccccccc-0000-4000-8000-000000000003';
  const CCV3_ID = 'RtrTNVfAq9uowmb2tfbzid';
  const CCV3_URL = `https://claude.ai/artifact/${CCV3_ID}`;
  const PH_ID = 'KaD7X6HnLKHKjzz7cecUVF';
  const LIMIT_SENTENCE = 'If the refusal names the daily publish limit, do not publish again today.';
  const FOREIGN_START = 'Another session changed the lane DB and did not publish.';

  let ccv3 = '';
  let ph = '';
  beforeEach(() => {
    ccv3 = path.join(tmp, 'ccv3');
    ph = path.join(tmp, 'ph');
    fs.mkdirSync(ccv3, { recursive: true });
    fs.mkdirSync(ph, { recursive: true });
  });

  const stamp = (file: string, ms: number): void => { const t = new Date(ms); fs.utimesSync(file, t, t); };
  /** A pending file whose last write (mtime) is `ageMs` before NOW. */
  const pend = (name: string, body: object, ageMs = MIN): string => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, JSON.stringify(body));
    stamp(f, NOW - ageMs);
    return f;
  };
  /** The body the reminder writes for a claim made `ageMs` before NOW. */
  const claim = (ageMs = MIN, extra: Record<string, unknown> = {}) =>
    ({ since: 'x', verbs: ['claim'], board: 'continuous-claude', askAt: NOW - ageMs, ...extra });
  const readPend = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const budgetDir = (): string => path.join(dir, 'budget');
  const budgetFile = (sid: string): string => path.join(budgetDir(), `${sid}.json`);
  /** A budget file of one session, last written `ageMs` before NOW. `body` may be raw text (a corrupt file). */
  const budget = (sid: string, body: object | string, ageMs = 0): string => {
    fs.mkdirSync(budgetDir(), { recursive: true });
    const f = budgetFile(sid);
    fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
    stamp(f, NOW - ageMs);
    return f;
  };
  const readBudget = (sid: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(budgetFile(sid), 'utf8'));
    } catch {
      return null;
    }
  };
  /** One Stop of an interactive session whose cwd is on the default board. */
  const stop = (sid: string = SID, now: number = NOW, extra: Record<string, unknown> = {}) =>
    gate.stopGate({ session_id: sid, hook_event_name: 'Stop', cwd: ccv3, ...extra }, baseEnv(), now);
  const reasonOf = (r: { output: object | null }): string => (r.output as { reason?: string } | null)?.reason ?? '';
  const BLOCK = { decision: 'block' };

  // ---- ask verbs ----

  it.each([SID, 'sess-1'])('G1: a pending file with only say approves, prints nothing and stays unmarked (session %s)', (sid) => {
    pend(`${sid}.json`, { since: 'x', verbs: ['say'], board: 'continuous-claude' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = stop(sid);
    const printed = log.mock.calls.length + err.mock.calls.length + stderr.mock.calls.length;
    vi.restoreAllMocks();
    expect(r.output).toBeNull();
    expect(printed).toBe(0);
    expect(readPend(`${sid}.json`).stopBlocked).toBeUndefined();
  });

  it('G1: note, add, state, adopt and apply-kanban never ask either', () => {
    pend(`${SID}.json`, { since: 'x', verbs: ['note', 'add', 'state', 'adopt', 'apply-kanban', 'seed', 'say'], board: 'continuous-claude' });
    expect(stop().output).toBeNull();
    expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
  });

  it('G2 (KEEP): a pending file with note and claim, no budget file: block, and the file is marked', () => {
    pend(`${SID}.json`, { since: 'x', verbs: ['note', 'claim'], board: 'continuous-claude' });
    expect(stop().output).toMatchObject(BLOCK);
    expect(readPend(`${SID}.json`).stopBlocked).toBe(true);
  });

  it.each(['claim', 'release', 'done', 'park'])('G2 (KEEP): the ask verb %s blocks', (verb) => {
    pend(`${SID}.json`, { since: 'x', verbs: ['say', verb, 'note'], board: 'continuous-claude', askAt: NOW - MIN });
    expect(stop().output).toMatchObject(BLOCK);
  });

  it('G20 (KEEP): an old-shape pending file with 50 verbs and no ask verb blocks (an ask verb may have dropped out of the list)', () => {
    pend(`${SID}.json`, { since: 'x', verbs: Array.from({ length: 50 }, () => 'note'), board: 'continuous-claude' });
    expect(stop().output).toMatchObject(BLOCK);
    expect(readPend(`${SID}.json`).stopBlocked).toBe(true);
  });

  it('G20: a new-shape pending file (marker v) with 50 say or note and no ask verb asks nothing', () => {
    pend(`${SID}.json`, { since: 'x', verbs: Array.from({ length: 50 }, (_, i) => (i % 2 ? 'say' : 'note')), board: 'continuous-claude', v: 2 });
    expect(stop().output).toBeNull();
    expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
  });

  it('G20: a new-shape full list whose ask verb dropped out still blocks: askAt is the ask signal', () => {
    pend(`${SID}.json`, { since: 'x', verbs: Array.from({ length: 50 }, () => 'say'), board: 'continuous-claude', v: 2, askAt: NOW - MIN });
    expect(stop().output).toMatchObject(BLOCK);
  });

  // ---- the 10-minute window and the cover rule ----

  it('G3: own claim, another session published the page 2 minutes ago: approve and leave the file unmarked; it is asked after the window', () => {
    budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - 2 * MIN } });
    pend(`${SID}.json`, claim(MIN));
    expect(stop().output).toBeNull();
    expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
    expect(stop(SID, NOW + 9 * MIN).output).toMatchObject(BLOCK);
  });

  it('G3: with two own batches, the board inside its window is skipped and the next board is asked', () => {
    budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - 2 * MIN } });
    pend(`${SID}.json`, claim(MIN));
    pend(`${SID}@ph-board.json`, claim(MIN, { board: 'ph-board' }));
    const r = stop();
    expect(r.output).toMatchObject(BLOCK);
    expect(reasonOf(r)).toContain('lane-board-ph-board.html');
    expect(reasonOf(r)).not.toContain(CCV3_ID);
    expect(readPend(`${SID}@ph-board.json`).stopBlocked).toBe(true);
    expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
    expect(readBudget(SID)?.asked?.[PH_ID]).toBe(NOW);
  });

  it('G4: the same publish 11 minutes ago and a newer claim: block, and the own budget file gets asked[id] = now', () => {
    budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - 11 * MIN } });
    budget(SID, { day: TODAY, n: 3, pages: { SomeOtherPage: NOW - HOUR } });
    pend(`${SID}.json`, claim(MIN));
    const r = stop();
    expect(r.output).toMatchObject(BLOCK);
    expect(reasonOf(r)).toContain(CCV3_URL);
    expect(readPend(`${SID}.json`).stopBlocked).toBe(true);
    const own = readBudget(SID);
    expect(own?.asked?.[CCV3_ID]).toBe(NOW);
    expect(own?.n).toBe(3); // the gate keeps what the reminder wrote
    expect(own?.pages).toEqual({ SomeOtherPage: NOW - HOUR });
    expect(fs.readdirSync(budgetDir()).sort()).toEqual([`${SID}.json`, `${SID_B}.json`]); // no .tmp left
  });

  it('G4: a session with no budget file gets one when it is asked', () => {
    pend(`${SID}.json`, claim(MIN));
    expect(stop().output).toMatchObject(BLOCK);
    expect(readBudget(SID)?.asked?.[CCV3_ID]).toBe(NOW);
  });

  it('G5: an own claim older than the last publish of its page approves (the page already shows it)', () => {
    budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - 12 * MIN } });
    pend(`${SID}.json`, claim(20 * MIN), 20 * MIN);
    expect(stop().output).toBeNull();
    expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
  });

  it('G5: a pending file with no askAt uses its mtime: older than the last publish approves, newer blocks', () => {
    budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - 12 * MIN } });
    const f = pend(`${SID}.json`, { since: 'x', verbs: ['claim'], board: 'continuous-claude' }, 20 * MIN);
    expect(stop().output).toBeNull();
    stamp(f, NOW - 5 * MIN);
    expect(stop().output).toMatchObject(BLOCK);
  });

  it('claim shown by another session\'s publish, then a note: approve (askAt is the change time, not the mtime)', () => {
    budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - 20 * MIN } });
    pend(`${SID}.json`, { since: 'x', verbs: ['claim', 'note'], board: 'continuous-claude', askAt: NOW - 30 * MIN }, MIN);
    expect(stop().output).toBeNull();
    expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
  });

  it('own claim 30 s before another session\'s publish: not covered (120 s margin); block once the window has passed', () => {
    budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - 120_000 } });
    pend(`${SID}.json`, claim(150_000), 150_000);
    expect(stop().output).toBeNull(); // 2 minutes after the publish: inside the window
    expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
    expect(stop(SID, NOW + 9 * MIN).output).toMatchObject(BLOCK); // 11 minutes after it
  });

  it('G6: another session asked for this page 3 minutes ago, no publish: approve; ask again after the window', () => {
    budget(SID_B, { day: TODAY, n: 0, asked: { [CCV3_ID]: NOW - 3 * MIN } });
    pend(`${SID}.json`, claim(MIN));
    expect(stop().output).toBeNull();
    expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
    expect(stop(SID, NOW + 8 * MIN).output).toMatchObject(BLOCK);
  });

  it('G19: two Stops at the same clock, two sessions with a claim each: the first blocks, the second approves', () => {
    pend(`${SID}.json`, claim(MIN));
    pend(`${SID_B}.json`, claim(MIN));
    expect(stop(SID).output).toMatchObject(BLOCK);
    expect(stop(SID_B).output).toBeNull();
    expect(readPend(`${SID_B}.json`).stopBlocked).toBeUndefined();
  });

  it('claim, block, then say: the second Stop approves (a say keeps askAt and stopBlocked)', () => {
    const env = baseEnv({ LANE_BOARD_AUTORENDER: '0', LANE_RENDER_SCRIPT: path.join(tmp, 'render-board.mjs') });
    const spawn = vi.fn();
    const lane = (command: string, now: number) => reminder.handle({
      session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: ccv3,
      tool_input: { command }, tool_response: { stdout: 'ok', stderr: '', interrupted: false },
    }, env, { spawn: spawn as never, now });
    const file = path.join(dir, `${SID}.json`);
    const stopAt = (now: number) => gate.stopGate({ session_id: SID, hook_event_name: 'Stop', cwd: ccv3 }, env, now);

    lane('node lane.mjs claim x', NOW - MIN);
    stamp(file, NOW - MIN);
    expect(stopAt(NOW).output).toMatchObject(BLOCK);
    lane('node lane.mjs say "hi"', NOW + MIN);
    stamp(file, NOW + MIN);
    expect(stopAt(NOW + 12 * MIN).output).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  // ---- the daily cap ----

  it('G7: the n of two budget files of today sums to 150: approve and leave the file unmarked. 149: block', () => {
    budget(SID_B, { day: TODAY, n: 100 });
    budget(SID_C, { day: TODAY, n: 50 });
    pend(`${SID}.json`, claim(MIN));
    expect(stop().output).toBeNull();
    expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
    budget(SID_C, { day: TODAY, n: 49 });
    expect(stop().output).toMatchObject(BLOCK);
  });

  it('G8 (KEEP): n = 200 in a file of yesterday does not count: block', () => {
    budget(SID_B, { day: YESTERDAY, n: 200 });
    pend(`${SID}.json`, claim(MIN));
    expect(stop().output).toMatchObject(BLOCK);
  });

  it('G9: limit true today in any budget file: approve. The same flag of yesterday: block', () => {
    budget(SID_B, { day: TODAY, n: 1, limit: true });
    pend(`${SID}.json`, claim(MIN));
    expect(stop().output).toBeNull();
    expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
    budget(SID_B, { day: YESTERDAY, n: 1, limit: true });
    expect(stop().output).toMatchObject(BLOCK);
  });

  // ---- another session's change (foreign candidate) ----

  it('G10: another session\'s done, 15 minutes old, on the board of the cwd, no publish since: block once, stamp asked, leave that file alone', () => {
    const foreign = pend(`${SID_B}.json`, { since: 'x', verbs: ['done'], board: 'continuous-claude', askAt: NOW - 15 * MIN }, 15 * MIN);
    const before = { text: fs.readFileSync(foreign, 'utf8'), mtime: fs.statSync(foreign).mtimeMs };
    const r = stop();
    expect(r.output).toMatchObject(BLOCK);
    expect(reasonOf(r).startsWith(FOREIGN_START)).toBe(true);
    expect(reasonOf(r)).not.toContain('this session changed the lane DB');
    expect(reasonOf(r)).toContain(CCV3_URL);
    expect(fs.readFileSync(foreign, 'utf8')).toBe(before.text); // no stopBlocked write to another session's file
    expect(fs.statSync(foreign).mtimeMs).toBe(before.mtime);
    expect(fs.existsSync(path.join(dir, `${SID}.json`))).toBe(false);
    expect(readBudget(SID)?.asked?.[CCV3_ID]).toBe(NOW);
    // 11 minutes later, still no publish: the change was asked once, never again
    expect(stop(SID, NOW + 11 * MIN).output).toBeNull();
    expect(stop(SID_C, NOW + 11 * MIN).output).toBeNull();
  });

  it('G10: a foreign change on a non-default board blocks from that board\'s cwd and names that board\'s page', () => {
    pend(`${SID_B}@ph-board.json`, { since: 'x', verbs: ['release'], board: 'ph-board', askAt: NOW - 15 * MIN }, 15 * MIN);
    const r = stop(SID, NOW, { cwd: ph });
    expect(r.output).toMatchObject(BLOCK);
    expect(reasonOf(r).startsWith(FOREIGN_START)).toBe(true);
    expect(reasonOf(r)).toContain(PH_URL);
    expect(reasonOf(r)).not.toContain(CCV3_ID);
    expect(readBudget(SID)?.asked?.[PH_ID]).toBe(NOW);
  });

  it('(KEEP) a foreign change that a later publish already shows is not asked', () => {
    pend(`${SID_B}.json`, { since: 'x', verbs: ['done'], board: 'continuous-claude', askAt: NOW - 40 * MIN }, 40 * MIN);
    budget(SID_C, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - 20 * MIN } });
    expect(stop().output).toBeNull();
  });

  it('G10: no string cwd in the payload: no foreign candidate, even when process.cwd() is on the board', () => {
    fs.writeFileSync(registry, JSON.stringify({ projects: [
      { name: 'CCv3', key: 'continuous-claude', path: process.cwd(), status: 'active' },
    ] }));
    pend(`${SID_B}.json`, { since: 'x', verbs: ['done'], board: 'continuous-claude', askAt: NOW - 15 * MIN }, 15 * MIN);
    expect(gate.stopGate({ session_id: SID, hook_event_name: 'Stop' }, baseEnv(), NOW).output).toBeNull();
    expect(gate.stopGate({ session_id: SID, hook_event_name: 'Stop', cwd: 42 }, baseEnv(), NOW).output).toBeNull();
    // control: the same fixture with that cwd in the payload is a foreign candidate
    expect(stop(SID, NOW, { cwd: process.cwd() }).output).toMatchObject(BLOCK);
  });

  it('G11 (KEEP): a foreign pending file 5 minutes old approves', () => {
    pend(`${SID_B}.json`, { since: 'x', verbs: ['done'], board: 'continuous-claude', askAt: NOW - 5 * MIN }, 5 * MIN);
    expect(stop().output).toBeNull();
  });

  it('G12 (KEEP): a foreign pending file for another board than the board of the cwd approves', () => {
    // no board field: the board comes from the name part after `@`, never the default board
    pend(`${SID_B}@ph-board.json`, { since: 'x', verbs: ['done'], askAt: NOW - 15 * MIN }, 15 * MIN);
    expect(stop().output).toBeNull();
  });

  it('G13 (KEEP): a foreign pending file with only say, or with no verbs list, approves', () => {
    pend(`${SID_B}.json`, { since: 'x', verbs: ['say'], board: 'continuous-claude' }, 15 * MIN);
    pend(`${SID_C}.json`, { since: 'x', board: 'continuous-claude' }, 15 * MIN);
    expect(stop().output).toBeNull();
  });

  it('(KEEP) a foreign file with stopBlocked approves: its own session was asked already', () => {
    pend(`${SID_B}.json`, { since: 'x', verbs: ['done'], board: 'continuous-claude', askAt: NOW - 15 * MIN, stopBlocked: true }, 15 * MIN);
    expect(stop().output).toBeNull();
  });

  it('F12 (KEEP, PIN): .render-*.json and .said-*.json that look like another session\'s done, 15 minutes old, never give a block', () => {
    // Only the name keeps these out: the body alone is a foreign candidate (the control below proves it).
    const body = { since: 'x', verbs: ['done'], board: 'continuous-claude', askAt: NOW - 15 * MIN };
    pend('.render-continuous-claude.json', { ...body, ts: NOW - 15 * MIN }, 15 * MIN);
    pend(`.said-${SID_B}.json`, { ...body, ts: NOW - 15 * MIN }, 15 * MIN);
    expect(stop().output).toBeNull();
    expect(fs.existsSync(budgetDir())).toBe(false);
    pend(`${SID_B}.json`, body, 15 * MIN);
    expect(stop().output).toMatchObject(BLOCK);
  });

  // ---- budget files that are missing, corrupt or odd ----

  it('G14: one corrupt budget file plus one valid file with a publish 2 minutes ago: approve; the corrupt file stays', () => {
    const bad = budget(SID_B, '{oops');
    budget(SID_C, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - 2 * MIN } });
    pend(`${SID}.json`, claim(MIN));
    expect(stop().output).toBeNull();
    expect(fs.readFileSync(bad, 'utf8')).toBe('{oops');
  });

  it('G15: the budget folder is a file: no throw, and an own claim approves (no block without an asked stamp)', () => {
    fs.writeFileSync(budgetDir(), 'not a folder');
    pend(`${SID}.json`, claim(MIN));
    let r: { output: object | null } = { output: {} };
    expect(() => { r = stop(); }).not.toThrow();
    expect(r.output).toBeNull();
    expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
    expect(fs.readFileSync(budgetDir(), 'utf8')).toBe('not a folder');
  });

  it('G16 (KEEP): a .tmp file in the budget folder is not read', () => {
    fs.mkdirSync(budgetDir(), { recursive: true });
    const tmpFile = path.join(budgetDir(), `${SID_B}.json.4242.tmp`);
    fs.writeFileSync(tmpFile, JSON.stringify({ day: TODAY, n: 500, limit: true, pages: { [CCV3_ID]: NOW - MIN } }));
    stamp(tmpFile, NOW);
    pend(`${SID}.json`, claim(MIN));
    expect(stop().output).toMatchObject(BLOCK);
  });

  it('(KEEP) a budget file over 65536 bytes is not read', () => {
    budget(SID_B, { day: TODAY, n: 150, limit: true, pad: 'x'.repeat(70_000) });
    pend(`${SID}.json`, claim(MIN));
    expect(stop().output).toMatchObject(BLOCK);
  });

  it('a negative n does not lower the total, and a stamp one day ahead is not used', () => {
    budget(SID_B, { day: TODAY, n: 150 });
    const odd = budget(SID_C, {
      day: TODAY, n: -500,
      pages: { [CCV3_ID]: NOW + 24 * HOUR },
      asked: { [CCV3_ID]: NOW + 24 * HOUR },
    });
    budget('dddddddd-0000-4000-8000-000000000004', { day: TODAY, n: '7', pages: 'x', asked: [NOW] });
    pend(`${SID}.json`, claim(MIN));
    expect(stop().output).toBeNull(); // 150 counts in full: the cap holds
    fs.rmSync(budgetFile(SID_B));
    expect(stop().output).toMatchObject(BLOCK); // the stamps from tomorrow do not open a window
    expect(fs.existsSync(odd)).toBe(true);
  });

  it('G17 (KEEP): the 24 h sweep leaves the budget folder and its files', () => {
    const f = budget(SID_B, { day: YESTERDAY, n: 4, pages: { [CCV3_ID]: NOW - 25 * HOUR } }, 25 * HOUR);
    stamp(budgetDir(), NOW - 25 * HOUR);
    const stale = pend(`${SID_C}.json`, claim(25 * HOUR), 25 * HOUR);
    stop();
    expect(fs.existsSync(stale)).toBe(false); // the sweep ran
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.statSync(budgetDir()).isDirectory()).toBe(true);
  });

  it('a budget file not written for 49 h is deleted, one of 47 h stays; a .tmp older than 48 h goes too', () => {
    const old = budget(SID_B, { day: '2026-11-10', n: 9 }, 49 * HOUR);
    const fresh = budget(SID_C, { day: '2026-11-10', n: 9 }, 47 * HOUR);
    const oldTmp = path.join(budgetDir(), `${SID_B}.json.77.tmp`);
    const freshTmp = path.join(budgetDir(), `${SID_C}.json.78.tmp`);
    fs.writeFileSync(oldTmp, '{}');
    fs.writeFileSync(freshTmp, '{}');
    stamp(oldTmp, NOW - 49 * HOUR);
    stamp(freshTmp, NOW - HOUR);
    expect(stop().output).toBeNull(); // nothing pending: the delete runs on an approve too
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(oldTmp)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(freshTmp)).toBe(true);
  });

  // ---- reason text ----

  it('G18: the reason holds `file. 2.` and the daily limit sentence, before the last sentence', () => {
    const reason = gate.blockReason('continuous-claude', baseEnv());
    expect(reason).toContain('file. 2.');
    expect(reason).toContain(LIMIT_SENTENCE);
    expect(reason.indexOf('publish the same file again')).toBeLessThan(reason.indexOf(LIMIT_SENTENCE));
    expect(reason.indexOf(LIMIT_SENTENCE)).toBeLessThan(reason.indexOf('Then finish your turn.'));
    expect(reason.trimEnd().endsWith('Then finish your turn.')).toBe(true);
  });

  // ---- session ids that are not a uuid, and headless runs ----

  it('G21 (KEEP): a session id that is not a uuid with an own claim blocks once and writes no budget file', () => {
    pend('sess-1.json', claim(MIN));
    expect(stop('sess-1').output).toMatchObject(BLOCK);
    expect(readPend('sess-1.json').stopBlocked).toBe(true);
    expect(stop('sess-1').output).toBeNull();
    expect(fs.existsSync(budgetDir())).toBe(false);
  });

  it('G21: the window and the cap apply to an id that is not a uuid too', () => {
    budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - 2 * MIN } });
    pend('sess-1.json', claim(MIN));
    expect(stop('sess-1').output).toBeNull();
    expect(readPend('sess-1.json').stopBlocked).toBeUndefined();
    budget(SID_B, { day: TODAY, n: 150 });
    expect(stop('sess-1', NOW + 30 * MIN).output).toBeNull();
    expect(fs.readdirSync(budgetDir())).toEqual([`${SID_B}.json`]);
  });

  it('G21 (KEEP): a session id that is not a uuid never takes a foreign candidate', () => {
    pend(`${SID_B}.json`, { since: 'x', verbs: ['done'], board: 'continuous-claude', askAt: NOW - 15 * MIN }, 15 * MIN);
    expect(stop('sess-1').output).toBeNull();
    expect(fs.existsSync(budgetDir())).toBe(false);
  });

  it('G22 (KEEP): a headless run approves and writes no budget file', () => {
    pend(`${SID}.json`, claim(MIN));
    pend(`${SID_B}.json`, { since: 'x', verbs: ['done'], board: 'continuous-claude', askAt: NOW - 15 * MIN }, 15 * MIN);
    const r = gate.stopGate({ session_id: SID, hook_event_name: 'Stop', cwd: ccv3 }, baseEnv(ENV_HEADLESS), NOW);
    expect(r.output).toBeNull();
    expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
    expect(fs.existsSync(budgetDir())).toBe(false);
  });

  // ---- review fixes (ids in the file header) ----

  describe('review fixes', () => {
    const SAY_50 = Array.from({ length: 50 }, () => 'say');
    const DONE_15 = { since: 'x', verbs: ['done'], board: 'continuous-claude', askAt: NOW - 15 * MIN };
    const stopPayload = (sid: string = SID) => ({ session_id: sid, hook_event_name: 'Stop', cwd: ccv3 });
    /** One direct write to the budget file of a session, with the given clock. */
    const upd = (now: number, change: (b: gate.Budget) => void, sid: string = SID): boolean =>
      gate.updateBudget(sid, baseEnv(), now, change);
    const addOne = (b: gate.Budget): void => { b.n += 1; };
    const lockFile = (sid: string = SID): string => `${budgetFile(sid)}.lock`;
    /** What the reminder hook gets for a lane command, and for an accepted publish of the default board page. */
    const reminderEnv = () => baseEnv({ LANE_BOARD_AUTORENDER: '0', LANE_RENDER_SCRIPT: path.join(tmp, 'render-board.mjs') });
    const laneCall = (command: string, now: number, spawn: unknown) => reminder.handle({
      session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: ccv3,
      tool_input: { command }, tool_response: { stdout: 'ok', stderr: '', interrupted: false },
    }, reminderEnv(), { spawn: spawn as never, now });
    const publishCall = (now: number, spawn: unknown) => reminder.handle({
      session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Artifact', cwd: ccv3,
      tool_input: { file_path: 'C:\\r\\lane-board.html', url: CCV3_URL }, tool_response: { url: CCV3_URL, stored: true },
    }, reminderEnv(), { spawn: spawn as never, now });

    // F1

    it('F1: another session\'s file with 50 say and no ask verb is never asked', () => {
      pend(`${SID_B}.json`, { since: 'x', verbs: SAY_50, board: 'continuous-claude' }, 15 * MIN);
      expect(stop().output).toBeNull();
      expect(readBudget(SID)).toBeNull();
    });

    it('F1 (KEEP): another session\'s full list whose ask verb dropped out still asks: askAt is the ask signal', () => {
      pend(`${SID_B}.json`, { since: 'x', verbs: SAY_50, board: 'continuous-claude', askAt: NOW - 15 * MIN }, MIN);
      expect(stop().output).toMatchObject(BLOCK);
    });

    // critic pass of 2026-11-12

    it('C1: a claim, then 50 say through the reminder: askAt stays the claim time and the gate blocks', () => {
      const spawn = vi.fn();
      laneCall('node lane.mjs claim x', NOW - 20 * MIN, spawn);
      for (let i = 1; i <= 50; i++) laneCall('node lane.mjs say "hi"', NOW - 20 * MIN + i * 1000, spawn);
      const p = readPend(`${SID}.json`);
      expect(p.verbs).toEqual(SAY_50); // the claim left the list
      expect(p).toMatchObject({ v: 2, askAt: NOW - 20 * MIN });
      expect(stop().output).toMatchObject(BLOCK);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('C2: the block keeps the marker and askAt of the pending file', () => {
      pend(`${SID}.json`, claim(MIN, { v: 2 }));
      expect(stop().output).toMatchObject(BLOCK);
      expect(readPend(`${SID}.json`)).toMatchObject({ v: 2, askAt: NOW - MIN, verbs: ['claim'], stopBlocked: true });
    });

    it('C3: a pending file that changed since the Stop read it is not marked, and the Stop approves', () => {
      const f = pend(`${SID}.json`, claim(MIN, { v: 2 }));
      // The budget write (rename) runs between the gate's read and its write of the pending file.
      fsCjs.renameSync = ((from: fs.PathLike, to: fs.PathLike): void => {
        fs.writeFileSync(f, JSON.stringify({ ...claim(0, { v: 2 }), verbs: ['claim', 'done'] }));
        realRename(from, to);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      const out = stop().output; // the afterEach of this file restores renameSync
      expect(out).toBeNull();
      expect(readPend(`${SID}.json`)).toMatchObject({ verbs: ['claim', 'done'], askAt: NOW });
      expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
      expect(readBudget(SID)?.asked?.[CCV3_ID]).toBeUndefined(); // no block, so no asked stamp stays
    });

    it('C6: a failed mark puts an older asked stamp back, and the next Stop asks', () => {
      budget(SID, { day: TODAY, n: 0, limit: false, pages: {}, asked: { [CCV3_ID]: NOW - 30 * MIN } });
      const f = pend(`${SID}.json`, claim(MIN, { v: 2 }));
      fsCjs.renameSync = ((from: fs.PathLike, to: fs.PathLike): void => {
        if (String(to).endsWith(`${SID}.json`) && !fs.readFileSync(f, 'utf8').includes('done')) {
          fs.writeFileSync(f, JSON.stringify({ ...claim(0, { v: 2 }), verbs: ['claim', 'done'] }));
        }
        realRename(from, to);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      expect(stop().output).toBeNull();
      expect(readBudget(SID)?.asked?.[CCV3_ID]).toBe(NOW - 30 * MIN);
      expect(stop(SID, NOW + 1000).output).toMatchObject(BLOCK);
    });

    it('C4: a headless run that opted in blocks for its own claim and writes no asked stamp', () => {
      pend(`${SID}.json`, claim(MIN, { v: 2 }));
      const optIn = baseEnv({ ...ENV_HEADLESS, LANE_CONTEXT_HEADLESS: '1' });
      const r = gate.stopGate({ session_id: SID, hook_event_name: 'Stop', cwd: ccv3 }, optIn, NOW);
      expect(r.output).toMatchObject(BLOCK);
      expect(readPend(`${SID}.json`).stopBlocked).toBe(true);
      expect(readBudget(SID)).toBeNull();
    });

    // F2

    it('F2: an old-shape claim (no askAt) that a publish covers stays covered after a say', () => {
      const spawn = vi.fn();
      budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - 20 * MIN } });
      const f = pend(`${SID}.json`, { since: 'x', verbs: ['claim'], board: 'continuous-claude' }, 30 * MIN);
      expect(stop().output).toBeNull(); // the publish of 20 minutes ago shows the claim of 30 minutes ago
      expect(laneCall('node lane.mjs say "hi"', NOW, spawn).decision.action).toBe('mark');
      stamp(f, NOW); // in production the rewrite moves the file time to the time of the say
      expect(readPend(`${SID}.json`)).toMatchObject({ verbs: ['claim', 'say'], askAt: NOW - 30 * MIN });
      expect(stop().output).toBeNull();
      expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('F2 (KEEP): a say on a say-only file sets no askAt', () => {
      const spawn = vi.fn();
      pend(`${SID}.json`, { since: 'x', verbs: ['say'], board: 'continuous-claude' }, 30 * MIN);
      laneCall('node lane.mjs say "hi"', NOW, spawn);
      expect(readPend(`${SID}.json`).verbs).toEqual(['say', 'say']);
      expect(readPend(`${SID}.json`).askAt).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    });

    // F3

    it.each(['EPERM', 'EBUSY', 'EACCES'])('F3: a rename that fails two times with %s is tried again: the write lands', (code) => {
      budget(SID, { day: TODAY, n: 40 });
      const r = failRename(2, code);
      let ok = false;
      try {
        ok = upd(NOW, (b) => { b.n += 1; b.pages[CCV3_ID] = NOW; });
      } finally {
        r.restore();
      }
      expect(ok).toBe(true);
      expect(r.calls).toHaveLength(3);
      expect(readBudget(SID)).toMatchObject({ day: TODAY, n: 41, pages: { [CCV3_ID]: NOW } });
      expect(fs.readdirSync(budgetDir())).toEqual([`${SID}.json`]);
    });

    it('F3: a rename that always fails gives false after 4 tries; the file is unchanged and no .tmp or .lock is left', () => {
      const f = budget(SID, { day: TODAY, n: 40 });
      const before = fs.readFileSync(f, 'utf8');
      const r = failRename(99);
      let ok = true;
      try {
        ok = upd(NOW, addOne);
      } finally {
        r.restore();
      }
      expect(ok).toBe(false);
      expect(r.calls).toHaveLength(4);
      expect(fs.readFileSync(f, 'utf8')).toBe(before);
      expect(fs.readdirSync(budgetDir())).toEqual([`${SID}.json`]);
    });

    it('F3 (KEEP): another rename error (ENOSPC) is not tried again', () => {
      budget(SID, { day: TODAY, n: 40 });
      const r = failRename(99, 'ENOSPC');
      let ok = true;
      try {
        ok = upd(NOW, addOne);
      } finally {
        r.restore();
      }
      expect(ok).toBe(false);
      expect(r.calls).toHaveLength(1);
      expect(fs.readdirSync(budgetDir())).toEqual([`${SID}.json`]);
    });

    it('F3: a publish whose first rename fails is still counted and stamped by the reminder', () => {
      const spawn = vi.fn();
      budget(SID, { day: TODAY, n: 40 });
      const own = pend(`${SID}.json`, claim(MIN));
      const r = failRename(1);
      try {
        publishCall(NOW, spawn);
      } finally {
        r.restore();
      }
      expect(fs.existsSync(own)).toBe(false);
      expect(readBudget(SID)).toMatchObject({ day: TODAY, n: 41, pages: { [CCV3_ID]: NOW } });
      expect(spawn).not.toHaveBeenCalled();
    });

    // F4

    it('F4: a second writer inside the first writer\'s load-change-rename never reports a write that is then lost', () => {
      const results: boolean[] = [];
      results.push(upd(NOW, (b) => {
        b.n += 1;
        results.push(upd(NOW, addOne)); // the other hook process of the same session, at the same instant
      }));
      expect(results).toHaveLength(2);
      expect(readBudget(SID)?.n).toBe(results.filter(Boolean).length); // every `true` is in the file
      expect(readBudget(SID)?.n).toBeGreaterThanOrEqual(1);
      expect(fs.readdirSync(budgetDir())).toEqual([`${SID}.json`]);
    });

    it('F4: a lock held by another process: no write and false; the gate then approves and leaves the file unmarked', () => {
      budget(SID, { day: TODAY, n: 3 });
      fs.writeFileSync(lockFile(), '4242'); // fresh: its file time is the real clock
      expect(upd(NOW, addOne)).toBe(false);
      expect(readBudget(SID)?.n).toBe(3);
      pend(`${SID}.json`, claim(MIN));
      expect(stop().output).toBeNull(); // no block without an asked stamp
      expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
      expect(fs.readFileSync(lockFile(), 'utf8')).toBe('4242'); // another process's lock stays
    });

    it('F4: a lock older than 5 s is stale: the writer takes it over and removes it', () => {
      budget(SID, { day: TODAY, n: 3 });
      fs.writeFileSync(lockFile(), '4242');
      const old = new Date(Date.now() - 6_000);
      fs.utimesSync(lockFile(), old, old);
      expect(upd(NOW, addOne)).toBe(true);
      expect(readBudget(SID)?.n).toBe(4);
      expect(fs.readdirSync(budgetDir())).toEqual([`${SID}.json`]);
    });

    it('F4: a .lock file not written for 49 h is deleted by the gate; a fresh one stays', () => {
      fs.mkdirSync(budgetDir(), { recursive: true });
      fs.writeFileSync(lockFile(SID_B), '1');
      fs.writeFileSync(lockFile(SID_C), '2');
      stamp(lockFile(SID_B), NOW - 49 * HOUR);
      stamp(lockFile(SID_C), NOW - HOUR);
      expect(stop().output).toBeNull();
      expect(fs.existsSync(lockFile(SID_B))).toBe(false);
      expect(fs.existsSync(lockFile(SID_C))).toBe(true);
    });

    // F5

    it('F5: a publish stamped 5 ms after this gate took its clock is seen: approve', () => {
      budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW + 5 } });
      pend(`${SID}.json`, claim(MIN));
      expect(stop().output).toBeNull();
      expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
    });

    it('F5: an ask stamped 5 ms after this gate took its clock is seen: approve', () => {
      budget(SID_B, { day: TODAY, n: 0, asked: { [CCV3_ID]: NOW + 5 } });
      pend(`${SID}.json`, claim(MIN));
      expect(stop().output).toBeNull();
      expect(readPend(`${SID}.json`).stopBlocked).toBeUndefined();
    });

    it('F5: a stamp 60 s ahead of the clock is used; one 61 s ahead is not', () => {
      pend(`${SID}.json`, claim(MIN));
      budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW + 60_000 } });
      expect(stop().output).toBeNull();
      budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW + 61_000 } });
      expect(stop().output).toMatchObject(BLOCK);
    });

    it('F5: a writer with an earlier clock keeps the later stamps of its own file', () => {
      expect(upd(NOW + 3, (b) => { b.n += 1; b.pages[CCV3_ID] = NOW + 3; b.asked[PH_ID] = NOW + 3; })).toBe(true);
      expect(upd(NOW, addOne)).toBe(true);
      expect(readBudget(SID)).toEqual({ day: TODAY, n: 2, limit: false, pages: { [CCV3_ID]: NOW + 3 }, asked: { [PH_ID]: NOW + 3 } });
    });

    it('F5: a writer whose clock is still in the old UTC day keeps the count of the new day', () => {
      const MIDNIGHT = Date.UTC(2026, 10, 13, 0, 0, 0);
      expect(upd(MIDNIGHT + 2, addOne)).toBe(true);
      expect(readBudget(SID)).toMatchObject({ day: '2026-11-13', n: 1 });
      expect(upd(MIDNIGHT - 1, addOne)).toBe(true); // the other hook process read its clock 3 ms earlier
      expect(readBudget(SID)).toMatchObject({ day: '2026-11-13', n: 2 });
    });

    it('F5 (KEEP): a day further ahead than the clock tolerance restarts the count and the limit', () => {
      budget(SID, { day: '2099-01-01', n: 90, limit: true });
      expect(upd(NOW, addOne)).toBe(true);
      expect(readBudget(SID)).toMatchObject({ day: TODAY, n: 1, limit: false });
    });

    // F6

    it('F6: a headless run that opted in never takes another session\'s change; the next interactive session is asked', () => {
      pend(`${SID_B}.json`, DONE_15, 15 * MIN);
      const optIn = baseEnv({ ...ENV_HEADLESS, LANE_CONTEXT_HEADLESS: '1' });
      expect(gate.stopGate(stopPayload(), optIn, NOW).output).toBeNull();
      expect(fs.existsSync(budgetDir())).toBe(false); // no asked stamp: the change is still open
      expect(stop(SID_C, NOW + 30 * MIN).output).toMatchObject(BLOCK);
    });

    it('F6 (KEEP): the headless run that opted in is still asked for its own claim', () => {
      pend(`${SID}.json`, claim(MIN));
      const optIn = baseEnv({ ...ENV_HEADLESS, LANE_CONTEXT_HEADLESS: '1' });
      expect(gate.stopGate(stopPayload(), optIn, NOW).output).toMatchObject(BLOCK);
      expect(readPend(`${SID}.json`).stopBlocked).toBe(true);
    });

    // F8

    it('F8 (PIN): a publish 9 min 59 s ago approves; one 10 min 0 s ago blocks', () => {
      pend(`${SID}.json`, claim(MIN));
      budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - (10 * MIN - 1000) } });
      expect(stop().output).toBeNull();
      budget(SID_B, { day: TODAY, n: 1, pages: { [CCV3_ID]: NOW - 10 * MIN } });
      expect(stop().output).toMatchObject(BLOCK);
    });

    it('F8 (PIN): an ask 9 min 59 s ago approves; one 10 min 0 s ago blocks', () => {
      pend(`${SID}.json`, claim(MIN));
      budget(SID_B, { day: TODAY, n: 0, asked: { [CCV3_ID]: NOW - (10 * MIN - 1000) } });
      expect(stop().output).toBeNull();
      budget(SID_B, { day: TODAY, n: 0, asked: { [CCV3_ID]: NOW - 10 * MIN } });
      expect(stop().output).toMatchObject(BLOCK);
    });

    it('F8 (PIN): another session\'s change 9 min 59 s old approves; one 10 min 0 s old blocks', () => {
      const done = (ageMs: number) => ({ since: 'x', verbs: ['done'], board: 'continuous-claude', askAt: NOW - ageMs });
      pend(`${SID_B}.json`, done(10 * MIN - 1000), 10 * MIN - 1000);
      expect(stop().output).toBeNull();
      expect(fs.existsSync(budgetDir())).toBe(false);
      pend(`${SID_B}.json`, done(10 * MIN), 10 * MIN);
      expect(stop().output).toMatchObject(BLOCK);
    });

    // F9

    it.each([
      // clock, the UTC date, the date of a zone on the other side of midnight
      ['02:00Z (20:00 Central of the day before)', Date.UTC(2026, 10, 13, 2, 0, 0), '2026-11-13', '2026-11-12'],
      ['22:00Z (the next day east of UTC+2)', Date.UTC(2026, 10, 12, 22, 0, 0), '2026-11-12', '2026-11-13'],
    ])('F9 (PIN): at %s the cap counts the UTC day and the asked stamp goes into the UTC day', (_name, at, utc, other) => {
      stamp(pend(`${SID}.json`, claim(MIN, { askAt: at - MIN })), at - MIN);
      stamp(budget(SID_B, { day: utc, n: 150 }), at);
      expect(stop(SID, at).output).toBeNull(); // 150 in the UTC day: the cap holds
      stamp(budget(SID_B, { day: other, n: 150 }), at);
      expect(stop(SID, at).output).toMatchObject(BLOCK); // the same count under the other date is not today
      expect(readBudget(SID)).toMatchObject({ day: utc, asked: { [CCV3_ID]: at } });
    });

    // F11

    it('F11: the retry sentence leaves out the daily limit, so the two refusal sentences do not conflict', () => {
      const reason = gate.blockReason('continuous-claude', baseEnv());
      expect(reason).toContain(
        'If the publish is refused for any reason other than the daily publish limit, publish the same file again: ' +
        `the refusal counts as the read. ${LIMIT_SENTENCE} Then finish your turn.`,
      );
      expect(reason).not.toContain('If the publish is refused, publish');
    });

    // F13

    it('F13 (PIN): the budget write goes through <file>.<pid>.tmp and one rename', () => {
      const r = failRename(0);
      let ok = false;
      try {
        ok = upd(NOW, addOne);
      } finally {
        r.restore();
      }
      expect(ok).toBe(true);
      expect(r.calls).toEqual([[`${budgetFile(SID)}.${process.pid}.tmp`, budgetFile(SID)]]);
      expect(readBudget(SID)).toMatchObject({ day: TODAY, n: 1 });
    });
  });
});

describe('S7: the reminder and the gate agree on the file name', () => {
  it('stateFile(sid, board) is the same function in both hooks', () => {
    const env = { LANE_BOARD_PENDING_DIR: '/p' };
    for (const id of ['sess-1', 'a/b:c', '4b24b2ac-363b-48dc-a215-014d2e188c51']) {
      for (const board of ['continuous-claude', 'ph-board']) {
        expect(gate.stateFile(id, board, env)).toBe(reminder.stateFile(id, board, env));
      }
    }
    expect(gate.stateFile('s', 'continuous-claude', env).replace(/\\/g, '/')).toBe('/p/s.json');
    expect(gate.stateFile('s', 'ph-board', env).replace(/\\/g, '/')).toBe('/p/s@ph-board.json');
  });

  it('the pending dir honours LANE_BOARD_PENDING_DIR in both hooks', () => {
    expect(gate.stateDir({ LANE_BOARD_PENDING_DIR: '/x' })).toBe('/x');
    expect(reminder.stateDir({ LANE_BOARD_PENDING_DIR: '/x' })).toBe('/x');
  });
});
