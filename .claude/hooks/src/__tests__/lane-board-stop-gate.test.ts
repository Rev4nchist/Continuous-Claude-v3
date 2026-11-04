import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as gate from '../lane-board-stop-gate.js';
import * as reminder from '../lane-board-republish-reminder.js';

const ENV_INTERACTIVE = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const ENV_HEADLESS = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };
const payload = (extra: Record<string, unknown> = {}) => ({ session_id: 'sess-1', hook_event_name: 'Stop', ...extra });

describe('decideStop (pure)', () => {
  it('approves a non-object payload', () => {
    expect(gate.decideStop(null, ENV_INTERACTIVE, {}).action).toBe('approve');
    expect(gate.decideStop('x', ENV_INTERACTIVE, {}).action).toBe('approve');
  });

  it('approves when Claude Code is already continuing because of a Stop hook', () => {
    expect(gate.decideStop(payload({ stop_hook_active: true }), ENV_INTERACTIVE, {}).action).toBe('approve');
  });

  it('approves a headless run even with a pending file', () => {
    expect(gate.decideStop(payload(), ENV_HEADLESS, {}).action).toBe('approve');
  });

  it('blocks a headless run that opted in with LANE_CONTEXT_HEADLESS=1', () => {
    const env = { ...ENV_HEADLESS, LANE_CONTEXT_HEADLESS: '1' };
    expect(gate.decideStop(payload(), env, {}).action).toBe('block');
  });

  it('approves with no session id', () => {
    expect(gate.decideStop({ hook_event_name: 'Stop' }, ENV_INTERACTIVE, {}).action).toBe('approve');
    expect(gate.decideStop(payload({ session_id: '' }), ENV_INTERACTIVE, {}).action).toBe('approve');
  });

  it('approves when nothing is pending', () => {
    expect(gate.decideStop(payload(), ENV_INTERACTIVE, null).action).toBe('approve');
  });

  it('approves when this batch was already blocked once', () => {
    expect(gate.decideStop(payload(), ENV_INTERACTIVE, { stopBlocked: true }).action).toBe('approve');
  });

  it('blocks a pending batch and tells the model what to run', () => {
    const d = gate.decideStop(payload(), ENV_INTERACTIVE, {});
    expect(d.action).toBe('block');
    if (d.action === 'block') {
      expect(d.reason).toContain(gate.RENDER_COMMAND);
      expect(d.reason).toContain(gate.BOARD_ARTIFACT_URL);
      expect(d.reason).toContain('omit capabilities');
    }
  });
});

describe('drift against the reminder hook', () => {
  let tmp = '';
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DIR: process.env.LANE_BOARD_PENDING_DIR };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stopgate-'));
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    delete process.env.LANE_BOARD_PENDING_DIR;
  });
  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.DIR !== undefined) process.env.LANE_BOARD_PENDING_DIR = saved.DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the exact file the reminder writes', () => {
    for (const id of ['sess-1', 'a/b:c', '4b24b2ac-363b-48dc-a215-014d2e188c51']) {
      expect(gate.stateFile(id)).toBe(reminder.stateFile(id));
    }
  });

  it('uses the same board constants as the reminder', () => {
    expect(gate.BOARD_ARTIFACT_ID).toBe(reminder.BOARD_ARTIFACT_ID);
    expect(gate.BOARD_ARTIFACT_URL).toBe(reminder.BOARD_ARTIFACT_URL);
    expect(gate.RENDER_COMMAND).toBe(reminder.RENDER_COMMAND);
    expect(gate.BOARD_FILE).toBe(reminder.BOARD_FILE);
  });
});
