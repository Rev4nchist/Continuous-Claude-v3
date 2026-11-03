/**
 * lane-board-republish-reminder: ways the decision can fail, one test each.
 *
 *  1. Nags on every note, not once per batch      -> pending=true must be silent
 *  2. Misses a state-changing verb                -> each listed verb must fire
 *  3. Fires on a read-only verb                   -> board/next/inbox/list/show stay silent
 *  4. Fires on a dry run                          -> --dry-run stays silent
 *  5. Fires on a failed command                   -> is_error / non-zero exit / failure event
 *  6. Never clears after a republish              -> Artifact to the board url (or lane-board.html) clears
 *  7. Clears on an unrelated artifact             -> another url must not clear
 *  8. Fires on text that only names lane.mjs      -> echo/quoted text, or no lane.mjs at all
 *  9. Crashes or speaks on a bad payload          -> malformed input gives 'none'
 * 10. Registered on a tool the runtime rejects    -> Bash, PowerShell and Artifact all accepted
 */
import { describe, expect, it } from 'vitest';

import {
  BOARD_ARTIFACT_URL,
  RENDER_COMMAND,
  decide,
} from '../lane-board-republish-reminder.js';

const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  session_id: 's1',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: { stdout: 'ok', stderr: '', interrupted: false },
  ...extra,
});

describe('lane change fires once per batch', () => {
  it('reminds on the first note and names the render command and the url', () => {
    const d = decide(bash('node scripts/coordination/lane.mjs note x "working on it"'), false);
    expect(d.action).toBe('remind');
    expect(d.verb).toBe('note');
    expect(d.message).toContain(RENDER_COMMAND);
    expect(d.message).toContain(BOARD_ARTIFACT_URL);
  });

  it('stays silent but keeps tracking while the session is already pending', () => {
    const d = decide(bash('node scripts/coordination/lane.mjs note x "again"'), true);
    expect(d.action).toBe('mark');
    expect(d.verb).toBe('note');
    expect(d.message).toBeUndefined();
  });

  it.each(['claim', 'release', 'done', 'note', 'say', 'add', 'apply-kanban', 'adopt'])(
    'the %s verb is a lane change',
    (verb) => {
      expect(decide(bash(`node scripts/coordination/lane.mjs ${verb} a b`), false).action).toBe('remind');
    },
  );

  it('accepts an absolute Windows path, a quoted path and a PowerShell call', () => {
    const cmds = [
      'node C:\\Users\\dkhay\\continuous-claude\\scripts\\coordination\\lane.mjs done lane-1',
      'node "C:\\Users\\dkhay\\continuous-claude\\scripts\\coordination\\lane.mjs" claim lane-1',
      'cd /c/repo && node ./scripts/coordination/lane.mjs release lane-1',
    ];
    for (const c of cmds) expect(decide(bash(c), false).action).toBe('remind');
    const ps = { ...bash('node scripts/coordination/lane.mjs note x "y"'), tool_name: 'PowerShell' };
    expect(decide(ps, false).action).toBe('remind');
  });
});

describe('commands that must not fire', () => {
  it.each(['board', 'next', 'inbox', 'list', 'show', 'peers', 'mine'])('read-only verb %s', (verb) => {
    expect(decide(bash(`node scripts/coordination/lane.mjs ${verb}`), false).action).toBe('none');
  });

  it('--dry-run on a changing verb', () => {
    expect(decide(bash('node scripts/coordination/lane.mjs apply-kanban --dry-run board.json'), false).action).toBe('none');
    expect(decide(bash('node scripts/coordination/lane.mjs apply-kanban board.json --dry-run'), false).action).toBe('none');
  });

  it('a real change next to a dry run in another command still fires', () => {
    const c = 'node scripts/coordination/lane.mjs apply-kanban --dry-run f.json && node scripts/coordination/lane.mjs note x "y"';
    expect(decide(bash(c), false).action).toBe('remind');
  });

  it('an unrelated command, or one without lane.mjs', () => {
    expect(decide(bash('git status'), false).action).toBe('none');
    expect(decide(bash('node scripts/other.mjs note x'), false).action).toBe('none');
    expect(decide(bash('echo done'), false).action).toBe('none');
  });

  it('quoted text that only names lane.mjs', () => {
    expect(decide(bash('git commit -m "docs: run node scripts/coordination/lane.mjs done when finished"'), false).action).toBe('none');
    expect(decide(bash('echo node scripts/coordination/lane.mjs done'), false).action).toBe('none');
  });

  it('other tools', () => {
    expect(decide({ ...bash('node scripts/coordination/lane.mjs note x y'), tool_name: 'Edit' }, false).action).toBe('none');
    expect(decide({ session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'lane-board.html' } }, true).action).toBe('none');
  });
});

describe('failed tool response never fires', () => {
  const note = 'node scripts/coordination/lane.mjs note x "y"';
  it('is_error true', () => {
    expect(decide(bash(note, { tool_response: { is_error: true } }), false).action).toBe('none');
  });
  it('non-zero exit code in the response', () => {
    expect(decide(bash(note, { tool_response: { exit_code: 1 } }), false).action).toBe('none');
  });
  it('a PostToolUseFailure event', () => {
    expect(decide(bash(note, { hook_event_name: 'PostToolUseFailure', error: 'Exit code 1' }), false).action).toBe('none');
  });
  it('a zero exit code still fires', () => {
    expect(decide(bash(note, { tool_response: { exit_code: 0 } }), false).action).toBe('remind');
  });
});

describe('republish clears pending', () => {
  const artifact = (tool_input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    session_id: 's1',
    hook_event_name: 'PostToolUse',
    tool_name: 'Artifact',
    tool_input,
    tool_response: { ok: true },
    ...extra,
  });

  it('a publish to the board url clears', () => {
    expect(decide(artifact({ url: BOARD_ARTIFACT_URL, file_path: 'x.html' }), true).action).toBe('clear');
  });

  it('a publish of lane-board.html clears, even from a Windows path', () => {
    expect(decide(artifact({ file_path: 'C:\\repo\\lane-board.html' }), true).action).toBe('clear');
    expect(decide(artifact({ file_path: '/repo/lane-board.html' }), true).action).toBe('clear');
  });

  it('a publish to another artifact does not clear', () => {
    expect(decide(artifact({ url: 'https://claude.ai/artifact/someOtherId', file_path: 'other.html' }), true).action).toBe('none');
  });

  it('a failed publish does not clear', () => {
    expect(decide(artifact({ url: BOARD_ARTIFACT_URL }, { tool_response: { is_error: true } }), true).action).toBe('none');
  });

  it('after the clear, the next lane change reminds again', () => {
    const note = bash('node scripts/coordination/lane.mjs note x "y"');
    expect(decide(note, false).action).toBe('remind');
    expect(decide(note, true).action).toBe('mark');
    expect(decide(artifact({ url: BOARD_ARTIFACT_URL }), true).action).toBe('clear');
    expect(decide(note, false).action).toBe('remind');
  });
});

describe('malformed payloads', () => {
  it.each([
    ['null', null],
    ['string', 'x'],
    ['empty object', {}],
    ['no tool_input', { tool_name: 'Bash', session_id: 's' }],
    ['command is a number', { tool_name: 'Bash', session_id: 's', tool_input: { command: 5 } }],
    ['tool_input is a string', { tool_name: 'Artifact', session_id: 's', tool_input: 'x' }],
    ['url is an object', { tool_name: 'Artifact', session_id: 's', tool_input: { url: {} } }],
  ])('%s gives none', (_name, payload) => {
    expect(decide(payload, false).action).toBe('none');
    expect(decide(payload, true).action).toBe('none');
  });

  it('a lane change without a session id gives none (no state key)', () => {
    const p = { tool_name: 'Bash', tool_input: { command: 'node scripts/coordination/lane.mjs note x y' } };
    expect(decide(p, false).action).toBe('none');
  });
});
