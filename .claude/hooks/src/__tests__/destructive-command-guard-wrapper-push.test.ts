/**
 * destructive-command-guard: a force push through the git wrapper (card prflow-push-blocks, design note rev 1 section 2 and test 7, 8).
 * The push patterns need the literal text `git push`, so `pwsh -File scripts/git-safe.ps1 push --force` matched none of them (a probe of the
 * built guard returned ALLOW). Own file: destructive-command-guard.test.ts is not part of this change.
 *
 *   - a wrapper force form in any spelling is allowed (the classifier does not see the wrapper)        -> W1, W2
 *   - the rewrite is too wide: a wrapper commit message that only names "push --force" now asks         -> W3
 *   - the rewrite changes a plain wrapper push of an own branch                                         -> W4
 */
import { describe, expect, it } from 'vitest';
import { decide } from '../destructive-command-guard.js';

const interactiveFor = (tool: 'Bash' | 'PowerShell') => ({ tool_name: tool, permission_mode: 'default' });
const FORMS = ['--force', '-f', '--force-with-lease', '+feat/x', ':feat/x', '--delete', '--mirror'];

describe('W: git wrapper pushes', () => {
  it('W1: git-safe.ps1 with a force form asks, in each spelling, in both shells', () => {
    // Breaks when: classifyText does not rewrite <path>git-safe.ps1 to git before the push patterns run.
    for (const form of FORMS) {
      const target = form.startsWith('+') || form.startsWith(':') ? `fork ${form}` : `${form} fork feat/x`;
      const spellings = [
        `pwsh -File scripts/git-safe.ps1 push ${target}`,
        `pwsh -NoProfile -File C:\\repo\\scripts\\git-safe.ps1 push ${target}`,
        `pwsh -File scripts/git-safe.ps1 -C C:\\repo push ${target}`,
        `pwsh -Command "& scripts/git-safe.ps1 push ${target}"`,
      ];
      for (const cmd of spellings) {
        expect(decide(cmd, interactiveFor('Bash'), {}).decision, `Bash ${cmd}`).not.toBe('allow');
        expect(decide(cmd, interactiveFor('PowerShell'), {}).decision, `PowerShell ${cmd}`).not.toBe('allow');
      }
    }
  });

  it('W2: git-for.ps1 with a force form asks', () => {
    // Breaks when: the rewrite covers git-safe.ps1 only.
    expect(decide('pwsh -File scripts/git-for.ps1 -UseGitSafe push --force fork feat/x', interactiveFor('Bash'), {}).decision).not.toBe('allow');
    expect(decide('pwsh -File scripts/git-for.ps1 push -f fork feat/x', interactiveFor('PowerShell'), {}).decision).not.toBe('allow');
  });

  it('W3: a wrapper commit message that only names "push --force" stays allowed (the H2 rows must still pass)', () => {
    // Breaks when: the rewrite reads the quoted message as a command.
    const cmd = String.raw`pwsh -File scripts/git-safe.ps1 -C C:\repo commit -m "fix(guard): git push --force now asks"`;
    expect(decide(cmd, interactiveFor('PowerShell'), {}).decision).toBe('allow');
    expect(decide(cmd, interactiveFor('Bash'), {}).decision).toBe('allow');
  });

  it('W4: a plain wrapper push of an own branch stays allowed', () => {
    // Breaks when: the rewrite makes every wrapper push an ask (the ordinary flow must add no question).
    for (const cmd of ['pwsh -File scripts/git-safe.ps1 push fork feat/x', 'pwsh -File scripts/git-safe.ps1 -C C:\\repo push fork feat/x']) {
      expect(decide(cmd, interactiveFor('PowerShell'), {}).decision, cmd).toBe('allow');
      expect(decide(cmd, interactiveFor('Bash'), {}).decision, cmd).toBe('allow');
    }
  });
});
