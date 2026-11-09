/**
 * blankInertQuotes (shared/inert-quotes.ts). How it can fail, and the test that catches it:
 *   - it changes the length, so an offset read in the result is wrong in the command      -> LENGTH
 *   - it blanks text a harmless command only prints                                       -> BLANKED
 *   - it blanks text that runs: a wrapper, an unknown program, a substitution, a pipe,
 *     a file write, a quote the two shells pair differently                               -> KEPT
 *   - it blanks a quoted string in a later, real segment                                  -> KEPT
 */
import { describe, expect, it } from 'vitest';
import { blankInertQuotes } from '../shared/inert-quotes.js';

describe('LENGTH', () => {
  it('keeps the length and the quote marks', () => {
    const c = 'node lane.mjs add x --title "gh pr create for fix" --note \'gh pr merge 5\'';
    const out = blankInertQuotes(c);
    expect(out).toHaveLength(c.length);
    expect(out).toBe(`node lane.mjs add x --title "${' '.repeat('gh pr create for fix'.length)}" --note '${' '.repeat('gh pr merge 5'.length)}'`);
  });
});

describe('BLANKED: a harmless command prints, stores or sends the text', () => {
  it.each([
    'node lane.mjs add x --title "gh pr create for fix"',
    'node C:/Users/dkhay/.claude/scripts/lane.mjs note x --note "land-pr.ps1 -Pr 5"',
    'claude -p "gh pr merge 5"',
    'git commit -m "gh pr create"',
    'echo "gh pr create"',
    'printf "%s" "gh pr create"',
    'Write-Host "gh pr create"',
    'gh pr comment 1 --body "gh pr merge 5"',
    'curl -d "gh pr create" https://example.com',
    'echo "gh pr create" 2>&1',
    'cd /tmp && echo "gh pr create"',
  ])('%s', (c) => {
    expect(blankInertQuotes(c)).not.toMatch(/create|merge|land-pr/);
  });
});

describe('KEPT: text that runs, or may run, keeps its words', () => {
  it.each([
    ['a shell wrapper', 'bash -c "gh pr create"'],
    ['a PowerShell wrapper', 'pwsh -Command "gh pr create"'],
    ['eval', 'eval "gh pr create"'],
    ['an unknown program', 'somecmd "gh pr create"'],
    ['a substitution in the string', 'echo "$(gh pr create)"'],
    ['a backtick in the string', 'git commit -m "`gh pr create`"'],
    ['a pipe into a shell', 'echo "gh pr create" | sh'],
    ['a pipe into anything', 'echo "gh pr create" | tee run.sh'],
    ['a redirect into a file', 'echo "gh pr create" > run.sh'],
    ['an append into a file', 'echo "gh pr create" >> run.sh'],
    ['a file writer', 'Set-Content run.ps1 "gh pr create"'],
    ['the call operator', '& "gh pr create"'],
    ['a lane verb that is not add, note or say', 'node lane.mjs run x "gh pr create"'],
    // Bash reads the whole text as one echo string; PowerShell reads `gh pr create` as its own command.
    ['a quote the two shells pair differently', 'echo "a\\" ; gh pr create ; echo "b"'],
  ])('%s', (_name, c) => {
    expect(blankInertQuotes(c)).toBe(c);
  });

  it('keeps every string when one segment is a real command (an earlier or later segment may change what an inert word does)', () => {
    const c = 'echo "gh pr create for fix"; bash -c "gh pr merge 5"';
    expect(blankInertQuotes(c)).toBe(c);
  });

  it.each([
    ['an ANSI-C string', "echo $'it\\'s' ; gh pr create ; echo 'x'"],
    ['a comment apostrophe', 'echo "x" # it\'s\ngh pr create\necho "a\'b"'],
    ['a smart quote', "Write-Output 'x\u2019 ; gh pr create ; Write-Output 'y'"],
    ['an indented leading pipe', 'Write-Output "gh pr create"\n   | Invoke-Expression'],
    ['a backtick substitution', "eval `echo a; echo 'gh pr create'`"],
    ['a stored variable', "printf -v x 'gh pr create'; $x"],
    ['an echo function', "echo() { eval \"$@\"; }; echo 'gh pr create'"],
    ['an echo alias', 'Set-Alias echo iex; echo "gh pr create"'],
    ['a nul path that is a file', 'echo "gh pr create" >nul/../x.sh; sh x.sh'],
    ['an escaped opening quote', "echo \\' ; gh pr create ; echo \\'"],
    ['a Unicode line break', 'Write-Output "gh pr create"\u2028iex $x'],
    ['a here-string', 'Write-Output @"\nx\n"@; gh pr create'],
  ])('KEPT: %s', (_n, c) => {
    expect(blankInertQuotes(c)).toBe(c);
  });

  it('a harmless neighbour (cd, git add) does not stop the blank', () => {
    expect(blankInertQuotes('cd /tmp && git add -A && git commit -m "gh pr create"')).not.toContain('gh pr create');
  });
});
