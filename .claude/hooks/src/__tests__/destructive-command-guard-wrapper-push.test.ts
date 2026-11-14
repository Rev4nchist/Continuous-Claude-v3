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
import { normalizeGitWrappers } from '../shared/destructive-classifier.js';

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

describe('W: normalizeGitWrappers cost grows linearly (seat read 16:0x: a regex that starts at every character of one long token is quadratic)', () => {
  // Ratio form, no wall-clock limit: the time of 4N characters against N, the minimum of 3 samples each. Linear gives about 4, quadratic about 16.
  // Breaks when: the match is not anchored at a token start (the optional path part starts at each character and runs to the token end).
  const RATIO_LIMIT = 12;
  const best = (fn: () => void): number => Math.min(...[0, 1, 2].map(() => { const t = performance.now(); fn(); return performance.now() - t; }));
  const N = 20_000;
  const shapes: Array<[string, (n: number) => string]> = [
    ['one long token with no space', (n) => 'a'.repeat(n)],
    ['a long path-like token (many slashes)', (n) => 'a/'.repeat(n / 2)],
    ['a long token of git-safe-like fragments', (n) => 'git-safe.p'.repeat(n / 10)],
  ];
  for (const [name, make] of shapes) {
    it(`W5: ${name}`, () => {
      const small = make(N);
      const big = make(4 * N);
      normalizeGitWrappers(small); // warm up
      const ratio = best(() => normalizeGitWrappers(big)) / Math.max(best(() => normalizeGitWrappers(small)), 0.05);
      expect(ratio, `ratio ${ratio.toFixed(1)}`).toBeLessThan(RATIO_LIMIT);
      expect(normalizeGitWrappers(small)).toBe(small); // nothing to rewrite
    });
  }

  it('W6: the anchored match still rewrites each wrapper spelling at a token start', () => {
    // Breaks when: the lookbehind is too strict (a wrapper after a quote, a separator or the text start is no longer read).
    for (const [text, want] of [
      ['pwsh -File scripts/git-safe.ps1 push --force fork x', 'git push --force fork x'],
      [String.raw`cd /r && pwsh -File C:\repo\scripts\git-safe.ps1 -C C:\repo push -f fork x`, 'cd /r && git push -f fork x'],
      ['& scripts/git-safe.ps1 push --force fork x', 'git push --force fork x'],
      ['echo ok; scripts/git-for.ps1 -UseGitSafe push --delete fork x', 'echo ok; git push --delete fork x'],
    ] as const) expect(normalizeGitWrappers(text), text).toBe(want);
  });
});
