/**
 * lane-agent-tag: adds --agent <type> to lane.mjs say|note inside a subagent.
 *
 * Failure list, one test each:
 *   T1  a subagent call is not tagged (say and note, Bash and PowerShell)
 *   T2  the flag lands at the end, so `lane.mjs say "x" && git push` tags the wrong command
 *   T3  a call with no agent_type (main thread) is rewritten
 *   T4  other verbs, other tools or a lane.mjs word in prose are rewritten
 *   T5  an agent_type with shell characters reaches the command line
 *   T6  a tagged command is tagged twice
 *   T7  the output sets permissionDecision (it would skip the permission prompt)
 *   T8  a main-thread session started with --agent (agent_type, no agent_id) is tagged as a subagent
 */
import { describe, expect, it } from 'vitest';
import { run, tagLaneCommand } from '../lane-agent-tag.js';

const pay = (o: object): string => JSON.stringify({ hook_event_name: 'PreToolUse', ...o });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const upd = (o: any): any => o.hookSpecificOutput?.updatedInput;

describe('lane-agent-tag', () => {
  it('T1+T2: tags say and note right after the verb, in Bash and PowerShell', () => {
    for (const tool of ['Bash', 'PowerShell']) {
      const out = run(pay({
        tool_name: tool, agent_id: 'a1', agent_type: 'kraken',
        tool_input: { command: 'node scripts/coordination/lane.mjs say "done" --to review && git status', description: 'd' },
      }));
      expect(upd(out).command).toBe('node scripts/coordination/lane.mjs say --agent kraken "done" --to review && git status');
      expect(upd(out).description).toBe('d');
    }
    expect(tagLaneCommand('node "C:/r/scripts/coordination/lane.mjs" note lane-1 "hi"', 'scout'))
      .toBe('node "C:/r/scripts/coordination/lane.mjs" note --agent scout lane-1 "hi"');
  });

  it('T3: no agent_type means no rewrite', () => {
    expect(run(pay({ tool_name: 'Bash', tool_input: { command: 'node scripts/coordination/lane.mjs say "x"' } }))).toEqual({});
  });

  it('T4: other verbs, other tools and prose are untouched', () => {
    const c = (command: string, tool = 'Bash') =>
      run(pay({ tool_name: tool, agent_id: 'a1', agent_type: 'kraken', tool_input: { command } }));
    expect(c('node scripts/coordination/lane.mjs board')).toEqual({});
    expect(c('node scripts/coordination/lane.mjs claim x')).toEqual({});
    expect(c('echo lane.mjs say hello')).toEqual({});
    expect(c('node scripts/coordination/lane.mjs say "x"', 'Edit')).toEqual({});
    expect(run('not json')).toEqual({});
  });

  it('T5: an unsafe agent_type is refused', () => {
    expect(tagLaneCommand('node lane.mjs say "x"', 'a; rm -rf /')).toBeNull();
    expect(tagLaneCommand('node lane.mjs say "x"', '')).toBeNull();
  });

  it('T6: a tagged command is left alone', () => {
    expect(tagLaneCommand('node lane.mjs say --agent kraken "x"', 'kraken')).toBeNull();
  });

  it('T7: sets no permissionDecision', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = run(pay({ tool_name: 'Bash', agent_id: 'a1', agent_type: 'k', tool_input: { command: 'node lane.mjs note a "b"' } }));
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  });
  it('T8: agent_type without agent_id (main thread under --agent) is not tagged; the live subagent payload is', () => {
    const command = 'node scripts/coordination/lane.mjs say "x"';
    expect(run(pay({ tool_name: 'Bash', agent_type: 'kraken', tool_input: { command } }))).toEqual({});
    expect(run(pay({ tool_name: 'Bash', agent_id: '', agent_type: 'kraken', tool_input: { command } }))).toEqual({});
    // keys seen in the real subagent PreToolUse payload (2026-11-03 probe)
    const live = run(pay({
      session_id: 's', transcript_path: 't', cwd: 'c', permission_mode: 'bypassPermissions', effort: 'high',
      tool_name: 'Bash', agent_id: 'a1bf8488042b4eb83', agent_type: 'general-purpose', tool_use_id: 'u',
      tool_input: { command },
    }));
    expect(upd(live).command).toBe('node scripts/coordination/lane.mjs say --agent general-purpose "x"');
  });
});
