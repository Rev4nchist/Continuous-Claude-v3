/**
 * permission-auto-allow: which PermissionRequests it leaves for the human.
 * P42 (2026-09-23): the destructive-command-guard now asks on destructive PowerShell, so this
 * hook must not auto-approve those, while every safe PowerShell call stays prompt-free.
 */
import { describe, it, expect } from 'vitest';
import { leaveToHuman } from '../permission-auto-allow.js';

describe('leaveToHuman', () => {
  it('always leaves AskUserQuestion, ExitPlanMode and Bash to the human', () => {
    for (const tool_name of ['AskUserQuestion', 'ExitPlanMode', 'Bash']) {
      expect(leaveToHuman({ tool_name })).toBe(true);
    }
  });

  it('leaves destructive PowerShell to the human (so the guard\'s ask is not swallowed)', () => {
    for (const command of ['git -C C:/r reset --hard origin/main', 'git stash -u', 'Remove-Item -Recurse -Force .\\dist']) {
      expect(leaveToHuman({ tool_name: 'PowerShell', tool_input: { command } })).toBe(true);
    }
  });

  it('auto-allows safe PowerShell (no new prompts)', () => {
    for (const command of ['git -C C:/r status', 'Get-ChildItem .', 'Remove-Item .\\one.txt', 'npm test']) {
      expect(leaveToHuman({ tool_name: 'PowerShell', tool_input: { command } })).toBe(false);
    }
  });

  it('auto-allows other tools (the .claude/ sensitive-file workaround)', () => {
    expect(leaveToHuman({ tool_name: 'Edit', tool_input: { file_path: 'C:/x/.claude/rules/a.md' } })).toBe(false);
    expect(leaveToHuman({ tool_name: 'PowerShell' })).toBe(false);
  });
});
