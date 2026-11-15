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

describe('W: a command that names the git wrapper with a force push form and cannot be fully parsed must ASK (CLI round 1, item e; seat: fail closed, no quoted-path spelling list)', () => {
  const askFor = (cmd: string, tool: 'Bash' | 'PowerShell') => decide(cmd, interactiveFor(tool), {}).decision;
  const FORCE_ROWS = [
    String.raw`pwsh -File "C:\my repo\scripts\git-safe.ps1" push --force fork feat/x`,
    String.raw`pwsh -File 'C:\my repo\scripts\git-safe.ps1' push -f fork feat/x`,
    'pwsh -File "C:/my repo/scripts/git-safe.ps1" push --force-with-lease fork feat/x',
    "& 'C:/my repo/scripts/git-safe.ps1' push --delete fork feat/x",
    'pwsh -NoProfile -File "scripts/git-for.ps1" -UseGitSafe push --mirror fork',
    'pwsh -File "scripts/git-safe.ps1" -C "C:/my repo" push fork +feat/x',
    'pwsh -File "scripts/git-safe.ps1" push fork :feat/x',
    'pwsh -File scripts/git-safe.ps1 push -uf fork feat/x',
    'pwsh -File "scripts/git-safe.ps1" push --all fork',
  ];
  it('W7: each force push form through a quoted or odd wrapper spelling asks, in both shells', () => {
    // Breaks when: only the spellings the rewrite knows are caught (a quoted path is stripped before the rewrite).
    for (const cmd of FORCE_ROWS) {
      expect(askFor(cmd, 'Bash'), `Bash ${cmd}`).not.toBe('allow');
      expect(askFor(cmd, 'PowerShell'), `PowerShell ${cmd}`).not.toBe('allow');
    }
  });

  it('W8: the controls stay allowed: a plain wrapper push, a quoted plain push, a commit message that names the wrapper and a force word', () => {
    // Breaks when: the fail-closed rule asks for every wrapper call.
    for (const cmd of [
      'pwsh -File "C:/my repo/scripts/git-safe.ps1" push fork feat/x',
      String.raw`pwsh -File "C:\my repo\scripts\git-safe.ps1" -C "C:\my repo" push fork feat/x`,
      'pwsh -File scripts/git-safe.ps1 commit -m "fix: the force push guard"',
      'pwsh -File "scripts/git-safe.ps1" status',
    ]) {
      expect(askFor(cmd, 'PowerShell'), cmd).toBe('allow');
      expect(askFor(cmd, 'Bash'), cmd).toBe('allow');
    }
  });

  it('W9: an unknown wrapper option before push does not hide a force form (seat delta read, hole 1)', () => {
    // Breaks when: the rule lists the wrapper options it knows and any other option token before `push` ends the match.
    for (const cmd of [
      'pwsh -File scripts/git-safe.ps1 -Verbose push --force fork feat/x',
      'pwsh -File scripts/git-safe.ps1 -Verbose -C C:/repo push -f fork feat/x',
      'pwsh -File scripts/git-safe.ps1 -SomeNewOption value push fork +feat/x',
      'pwsh -File "scripts/git-safe.ps1" -Debug push --mirror fork',
    ]) {
      expect(askFor(cmd, 'Bash'), `Bash ${cmd}`).not.toBe('allow');
      expect(askFor(cmd, 'PowerShell'), `PowerShell ${cmd}`).not.toBe('allow');
    }
  });

  it('W10: a quoted force argument asks (seat delta read, hole 2)', () => {
    // Breaks when: the rule reads the raw text only, so `"+feat/x"` or `'--force'` does not start with the force character.
    for (const cmd of [
      'pwsh -File scripts/git-safe.ps1 push fork "+feat/x"',
      "pwsh -File scripts/git-safe.ps1 push fork '--force'",
      'pwsh -File scripts/git-safe.ps1 push "--force-with-lease" fork feat/x',
      "pwsh -File scripts/git-safe.ps1 push fork ':feat/x'",
    ]) {
      expect(askFor(cmd, 'Bash'), `Bash ${cmd}`).not.toBe('allow');
      expect(askFor(cmd, 'PowerShell'), `PowerShell ${cmd}`).not.toBe('allow');
    }
  });

  it('W11: the controls of holes 1 and 2 stay allowed', () => {
    // Breaks when: the wider rule asks for an ordinary push, a refspec of an own branch or a message that names the force word.
    for (const cmd of [
      'pwsh -File scripts/git-safe.ps1 -Verbose push fork feat/x',
      'pwsh -File scripts/git-safe.ps1 push -u fork feat/x',
      'pwsh -File scripts/git-safe.ps1 push fork HEAD:refs/heads/feat/x',
      'pwsh -File scripts/git-safe.ps1 push fork "feat/x"',
      'pwsh -File scripts/git-safe.ps1 -Verbose commit -m "fix: push --force now asks"',
    ]) {
      expect(askFor(cmd, 'PowerShell'), cmd).toBe('allow');
      expect(askFor(cmd, 'Bash'), cmd).toBe('allow');
    }
  });

  // Seat read 18:4x: the option group was EXPONENTIAL on a NON-match (a dash token read as an option or as the value of the option before it:
  // every split was tried; about x1.6 per option, 34 options = 200 ms, 50 = minutes). The ratio tests use 14 and 28 options: linear gives about 2,
  // exponential about 1.6^14 = 700. The fixed 200-option rows come after them, so a regression fails the ratio rows before the 200 rows can hang.
  const best = (fn: () => void): number => Math.min(...[0, 1, 2].map(() => { const t = performance.now(); fn(); return performance.now() - t; }));
  const wrapper = (opts: string, tail: string, n: number) => `pwsh -File scripts/git-safe.ps1 ${opts.repeat(n)}${tail}`;
  const shapes: Array<[string, string, string]> = [
    ['W12a: options then a subcommand that is not push', '-a ', 'commit -m x'],
    ['W12b: options then a push with no force form', '-a ', 'push fork feat/x'],
    ['W12c: options with values then a subcommand that is not push', '-a b ', 'commit -m x'],
  ];
  for (const [name, opts, tail] of shapes) {
    it(`${name} (ratio form: 28 options against 14)`, () => {
      // Breaks when: a dash token can be read as an option or as a value (every split is tried: exponential on a non-match).
      const small = wrapper(opts, tail, 14);
      const big = wrapper(opts, tail, 28);
      askFor(small, 'PowerShell');
      const ratio = best(() => askFor(big, 'PowerShell')) / Math.max(best(() => askFor(small, 'PowerShell')), 0.05);
      expect(ratio, `ratio ${ratio.toFixed(1)}`).toBeLessThan(40);
    });
  }

  it('W13: 200 options then a non-push subcommand or a plain push return at once and allow; a force push still asks', () => {
    // Breaks when: the option group backtracks, or a long run of options hides the force form.
    expect(askFor(wrapper('-a ', 'commit -m x', 200), 'PowerShell')).toBe('allow');
    expect(askFor(wrapper('-a ', 'push fork feat/x', 200), 'PowerShell')).toBe('allow');
    expect(askFor(wrapper('-a ', 'push --force fork feat/x', 200), 'PowerShell')).not.toBe('allow');
    expect(askFor(wrapper('-a b ', 'push fork +feat/x', 200), 'Bash')).not.toBe('allow');
  });

  it('W14: a quoted value that starts with a dash still works as an option value', () => {
    // Breaks when: the "bare value must not start with a dash" fix also drops a QUOTED value that starts with a dash.
    expect(askFor('pwsh -File scripts/git-safe.ps1 -C "-weird dir" push --force fork feat/x', 'PowerShell')).not.toBe('allow');
    expect(askFor("pwsh -File scripts/git-safe.ps1 -C '-weird dir' push fork feat/x", 'PowerShell')).toBe('allow');
  });
});
