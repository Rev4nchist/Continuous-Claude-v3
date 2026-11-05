/**
 * lane-board-stop-gate: blocks the end of a turn once per batch until the board page is published.
 *
 * Failure list, one test (or group) each:
 *   S1  a pending file for a board with a phone page does not block (or a board with none does)
 *       Only the default board has a phone page (no `board` field in artifacts.json), so a file for any other board never blocks.
 *   S2  <sid>@<board>.json is not seen (only the bare <sid>.json is read)
 *   S3  the block repeats inside one batch (stopBlocked not written), or a second board's batch is hidden by the first
 *   S4  a headless run, a stop_hook_active continuation, or no session id blocks
 *   S5  the reason names the CCv3 url for another board (or a relative render command)
 *   S6  a stale pending file (older than 24 h) stays forever, or another session's file blocks this one
 *   S7  the reminder and the gate disagree on the file name
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as gate from '../lane-board-stop-gate.js';
import * as reminder from '../lane-board-republish-reminder.js';
import { renderBoardCmd } from '../shared/lane-board.js';

const ENV_INTERACTIVE = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const ENV_HEADLESS = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };
const payload = (extra: Record<string, unknown> = {}) => ({ session_id: 'sess-1', hook_event_name: 'Stop', ...extra });
const CCV3 = { board: 'continuous-claude', pending: {} };
const PH = { board: 'ph-board', pending: {} };

let tmp = '';
let dir = '';
let home = '';
const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...ENV_INTERACTIVE, LANE_BOARD_PENDING_DIR: dir, CCV3_USER_HOME: home, ...extra,
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stopgate-'));
  dir = path.join(tmp, 'pending');
  home = path.join(tmp, 'home');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, 'continuous-claude', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, 'continuous-claude', '.claude', 'artifacts.json'), JSON.stringify({ artifacts: [
    { id: 'agentic-os-lane-board', url: 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid', publish_from: 'lane-board.html' },
    { id: 'other-page', url: 'https://claude.ai/artifact/PHPHPH1', publish_from: 'other.html' },
  ] }));
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

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
    expect(gate.decideStop(payload(), baseEnv(), [{ board: 'zz-board', pending: {} }]).action).toBe('approve');
  });

  it('S3: skips a blocked batch and every other board, blocks the default board batch', () => {
    const none = gate.decideStop(payload(), baseEnv(), [
      { board: 'continuous-claude', pending: { stopBlocked: true } },
      { board: 'zz-board', pending: {} },
      PH,
    ]);
    expect(none.action).toBe('approve');
    const d = gate.decideStop(payload(), baseEnv(), [{ board: 'zz-board', pending: {} }, PH, CCV3]);
    expect(d.action).toBe('block');
    if (d.action === 'block') expect(d.board).toBe('continuous-claude');
  });

  it('S1: a board other than the default has no phone page, whatever artifacts.json holds', () => {
    expect(gate.decideStop(payload(), baseEnv(), [PH]).action).toBe('approve');
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

  it('S1: a <sid>@<board>.json file never blocks (no phone page) and is not marked', () => {
    put('sess-1@ph-board.json', { since: 'x', verbs: ['claim'], board: 'ph-board' });
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
    expect(read('sess-1@ph-board.json').stopBlocked).toBeUndefined();
  });

  it('S1: approves a file for a board with no phone page', () => {
    put('sess-1@zz-board.json', { since: 'x', verbs: ['claim'], board: 'zz-board' });
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
    expect(read('sess-1@zz-board.json').stopBlocked).toBeUndefined();
  });

  it('S2: an old PR0 file (<sid>.json, no board field) is the CCv3 batch', () => {
    put('sess-1.json', { since: 'x', verbs: ['note'] });
    const r = gate.stopGate(payload(), baseEnv());
    expect(JSON.stringify(r.output)).toContain('RtrTNVfAq9uowmb2tfbzid');
  });

  it('S3: two boards pending: only the default board batch blocks, once', () => {
    put('sess-1.json', { since: 'x', verbs: ['note'], board: 'continuous-claude' });
    put('sess-1@ph-board.json', { since: 'x', verbs: ['note'], board: 'ph-board' });
    expect(JSON.stringify(gate.stopGate(payload(), baseEnv()).output)).toContain('RtrTNVfAq9uowmb2tfbzid');
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
    expect(read('sess-1@ph-board.json').stopBlocked).toBeUndefined();
  });

  it('S4: a headless run approves and does not mark the batch', () => {
    put('sess-1.json', { since: 'x', verbs: ['note'] });
    expect(gate.stopGate(payload(), baseEnv(ENV_HEADLESS)).output).toBeNull();
    expect(read('sess-1.json').stopBlocked).toBeUndefined();
  });

  it('S6: another session file never blocks this session', () => {
    put('sess-2.json', { since: 'x', verbs: ['note'] });
    put('sess-12.json', { since: 'x', verbs: ['note'] });
    put('sess-1x@ph-board.json', { since: 'x', verbs: ['note'], board: 'ph-board' });
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
    put('sess-1.json', { since: 'x', verbs: ['note'] }, 30 * 3600_000);
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
  });

  it('a missing dir approves', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    expect(gate.stopGate(payload(), baseEnv()).output).toBeNull();
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
