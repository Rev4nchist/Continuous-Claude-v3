/**
 * Card coord-file-claims-text-false-match: a held file named INSIDE text that a command writes or prints is not a write to it.
 *
 * Seat ruling 2026-11-14 on design note 01: strings are blanked ONLY in a segment whose head is on an ALLOW list of data heads
 * (Add-Content, Set-Content, Out-File, echo, Write-Host, Write-Output, printf, git commit -m, lane note and say). Any other head,
 * a known runner or not, keeps today's whole-text reading. A fail-closed sign (unpaired quote, `$(`, backtick, smart quote,
 * comment, a here-string with no closer) keeps the whole text as it is.
 *
 * Ways this can fail (one test group each):
 *  1. A false deny stays: a held path inside a string of a data head (the four observed commands, the here-string body).
 *  2. A real write is missed: the path is the write target (unquoted, whole-string quoted, -Path after -Value, a redirect target).
 *  3. A real write after a data segment is missed (`echo "x" ; sed -i ... <held>`, a pipe to tee).
 *  4. A runner or an unlisted head gets its strings blanked (bash -c, pwsh -Command, xargs sh -c, wsl bash -c, python -c).
 *  5. A fail-closed sign is ignored (unpaired quote, command substitution, smart quote, comment, a here-string with no closer).
 */
import { describe, it, expect } from 'vitest';
import { classifyShellText } from '../shared/write-targets.js';

const HELD = [{ filePath: 'src/a.ts', forms: ['src/a.ts', 'c:/repo/src/a.ts', '/c/repo/src/a.ts'] }];
const verdict = (text: string, fold = false) => classifyShellText(text, HELD, fold);

describe('data heads: a held path inside the written text is no write', () => {
  it.each([
    // the four observed shapes: a log or note file gets text that names the held file
    ['Add-Content log.md "note: edited src/a.ts today"'],
    ["Add-Content -Path log.md -Value 'see src/a.ts'"],
    ['Add-Content -Path log.md -Value "rm src/a.ts is the plan"'],
    ['Set-Content notes.md "fixed src/a.ts"'],
    ['"x" | Out-File notes.md -InputObject "see src/a.ts"'],
    ['Write-Host "fixing src/a.ts now"'],
    // a one-word string that only looks like another file is no operand of the held file (F1 control)
    ['Add-Content log.md "other/src/a.ts"'],
    ['Add-Content log.md "src/a.tsx"'],
    ['Add-Content log.md "src/a.ts.md"'],
    ['Add-Content log.md "my notes src/a.ts.md"'],
    ['Write-Output "mv x src/a.ts"'],
    ['echo "rm src/a.ts is the plan"'],
    ["printf '%s' 'Set-Content src/a.ts'"],
    ['git commit -m "fix: rm src/a.ts"'],
    ['node C:/Users/dkhay/.claude/scripts/lane.mjs note card "mv x src/a.ts"'],
    ['node C:/Users/dkhay/.claude/scripts/lane.mjs say "cp x src/a.ts" --to peer'],
    // two data segments
    ['Add-Content log.md "note src/a.ts"; echo "done src/a.ts"'],
    // a plain head (cd, Set-Location, git add, git status) beside a data head does not stop the blanking
    ['cd C:/repo; Add-Content log.md "note rm src/a.ts"'],
    // a here-string body is data
    ["Add-Content -Path log.md -Value @'\nrm src/a.ts\n'@"],
    ['Add-Content -Path log.md -Value @"\nsrc/a.ts changed, then mv x src/a.ts\n"@'],
  ])('does not deny: %s', (text) => {
    expect(verdict(text).kind).not.toBe('deny');
  });
});

describe('data heads: a real write to the held file still denies', () => {
  it.each([
    ['Set-Content src/a.ts "x"'],
    ['Set-Content "src/a.ts" -Value "hello"'],
    ["Set-Content -LiteralPath 'src/a.ts' -Value 'hello'"],
    ['Add-Content -Value "text" -Path src/a.ts'],
    ['Add-Content -Value "text" -Path "src/a.ts"'],
    ['Set-Content src/a.ts "note src/a.ts"'],
    ['"x" | Out-File src/a.ts'],
    ['echo "x" > src/a.ts'],
    ['echo "x" > "src/a.ts"'],
    ['echo "src/a.ts" > src/a.ts'],
    // F1 (seat review round 1): a one-word string that holds the held path plus a suffix is an OPERAND, not prose.
    // PATH_END of the classifier allows these characters after the path, and the shell still writes the held file.
    ['Set-Content "src/a.ts*" x'],
    ["Set-Content 'src/a.ts*' -Value x"],
    ['Out-File "src/a.ts:tag"'],
    ['Add-Content -Path "src/a.ts:stream" -Value "x"'],
    ['Set-Content "./src/a.ts?" x'],
    ['Set-Content "src/a.ts " x'],
    ['echo x > "src/a.ts"extra'],
    ['echo "x" | tee src/a.ts'],
    ['echo "x" | tee "src/a.ts"'],
    ['git commit -m "msg" ; rm src/a.ts'],
  ])('denies: %s', (text) => {
    expect(verdict(text)).toMatchObject({ kind: 'deny', filePath: 'src/a.ts' });
  });

  it('denies a real write in the segment AFTER a listed head and a semicolon', () => {
    expect(verdict('echo "note" ; sed -i s/a/b/ src/a.ts').kind).toBe('deny');
    expect(verdict('Write-Host "src/a.ts"; Set-Content src/a.ts x').kind).toBe('deny');
    expect(verdict('Add-Content log.md "src/a.ts"\nRemove-Item src/a.ts').kind).toBe('deny');
  });
});

describe('unlisted heads and runners keep today\'s reading (allow list, not deny list)', () => {
  it.each([
    ['bash -c "echo x > src/a.ts"'],
    ['pwsh -Command "Set-Content src/a.ts x"'],
    ['pwsh -NoProfile -Command "Add-Content src/a.ts x"'],
    ['xargs sh -c "tee src/a.ts"'],
    ['wsl bash -c "rm src/a.ts"'],
    ['python -c "import os; os.system(\'rm src/a.ts\')"'],
    ['cmd /c "del src/a.ts"'],
    ['some-unknown-wrapper "rm src/a.ts"'],
    ['Invoke-Expression "Set-Content src/a.ts x"'],
    ['iex "Remove-Item src/a.ts"'],
  ])('denies: %s', (text) => {
    expect(verdict(text).kind).toBe('deny');
  });
});

describe('fail closed: a sign that the quotes may be misread keeps the whole text', () => {
  it.each([
    ['unpaired quote', 'Add-Content log.md "rm src/a.ts'],
    ['unpaired single quote', "Add-Content log.md 'rm src/a.ts"],
    ['command substitution', 'Add-Content log.md "$(date) rm src/a.ts"'],
    ['backtick', 'Add-Content log.md "`n rm src/a.ts"'],
    ['smart quote', 'Add-Content log.md \u201Crm src/a.ts\u201D'],
    ['comment', 'echo "x" # rm src/a.ts'],
    ['here-string with no closer', "Add-Content -Path log.md -Value @'\nrm src/a.ts\n"],
    ['here-string body with a command substitution', 'Add-Content -Path log.md -Value @"\n$(date) rm src/a.ts\n"@'],
    ['quote pairing differs between Bash and PowerShell', 'echo "a \\" b" rm src/a.ts'],
    ['segment piped to a shell', 'echo "rm src/a.ts" | sh'],
    ['alias redefines a data word', 'Set-Alias echo Invoke-Expression; echo "rm src/a.ts"'],
    ['an unlisted segment beside a data segment', 'Add-Content log.md "note rm src/a.ts"; some-wrapper x'],
    ['a line continuation joins two lines', 'Add-Content log.md "note" \\\n  "rm src/a.ts"'],
    ['brace outside a string', 'echo "x"; { rm src/a.ts }'],
  ])('denies (%s): %s', (_name, text) => {
    expect(verdict(text).kind).toBe('deny');
  });
});

// CodeRabbit CLI run 1 of 2 finding (a), Dave's tap "One last fix, then land": a held file whose OWN name has a space.
// A string that holds the held path plus white-space-free text around it is still ONE operand (a wildcard, a stream).
// Only the white space of the path itself is allowed in an operand. Prose around the path still has spaces.
describe('a held path with a space in its name', () => {
  const HELD_SP = [{ filePath: 'src/my file.ts', forms: ['src/my file.ts', 'c:/repo/src/my file.ts'] }];
  const sp = (text: string) => classifyShellText(text, HELD_SP, false);

  it.each([
    ['Set-Content -Path "src/my file.ts*" -Value x'],
    ["Set-Content 'src/my file.ts?' x"],
    ['Out-File "src/my file.ts:tag"'],
    ['Set-Content "src/my file.ts" -Value "note"'],
    ['Set-Content "src/my file.ts " x'],
    ['Set-Content "./src/my file.ts*" x'],
    ['Add-Content -Path "c:/repo/src/my file.ts:stream" -Value "x"'],
  ])('denies: %s', (text) => {
    expect(sp(text)).toMatchObject({ kind: 'deny', filePath: 'src/my file.ts' });
  });

  it.each([
    ['Add-Content log.md "note: edited src/my file.ts today"'],
    ['Add-Content log.md "see src/my file.ts"'],
    ['Add-Content log.md "src/my file.tsx"'],
    ['Write-Host "fixing src/my file.ts now"'],
  ])('does not deny prose or another file: %s', (text) => {
    expect(sp(text).kind).not.toBe('deny');
  });
});

describe('platform and case', () => {
  it('folds case on a case-folding platform for a data string too', () => {
    expect(verdict('Add-Content log.md "see SRC/A.TS"', true).kind).not.toBe('deny');
    expect(verdict('Set-Content SRC/A.TS "x"', true).kind).toBe('deny');
  });
});

// Card coord-file-guard-named-file (seat ruling 2026-11-15, Q3): inside a double-quoted PowerShell string a backtick
// escape from a short allow list (`n `r `t `` `" `' `0) is plain text, for the PowerShell tool ONLY. An escape that is not
// on the list, a backtick outside such a string, and every backtick for the Bash reading keep today's result: the whole
// text is kept, so a write cue before a named held file still denies.
//
// Ways this can fail (one group each):
//  1. A false deny stays: a note or milestone line with a backtick line break that only NAMES a held file.
//  2. A real write is missed: the held file is the target, a cue stays outside the string, a redirect follows.
//  3. The default is loosened: an unlisted escape, a backtick-dollar, a backtick outside a string, a single-quoted
//     backtick, and the Bash reading must all keep the deny.
const ps = (text: string, fold = false) => classifyShellText(text, HELD, fold, true);

describe('PowerShell backtick escapes in a double-quoted data string', () => {
  it.each([
    ['Add-Content -Path C:/x/milestones/own.md -Value "line one names src/a.ts`nline two"'],
    ['Add-Content -Path own.md -Value "- 08:20 CST: src/a.ts landed`n- next: see src/a.ts`tdone"'],
    ['Set-Content notes.md "fixed src/a.ts`r`nthen mv x src/a.ts"'],
    ['Add-Content own.md "a `"quoted`" word and src/a.ts"'],
    ['Add-Content own.md "a literal `` backtick and src/a.ts"'],
    ['Add-Content own.md "nul `0 then src/a.ts"'],
    ['node C:/Users/dkhay/.claude/scripts/lane.mjs note card "mv x src/a.ts`nmore"'],
  ])('does not deny: %s', (text) => {
    expect(ps(text).kind).not.toBe('deny');
  });
});

describe('PowerShell backtick escapes: a real write still denies', () => {
  it.each([
    ['Add-Content src/a.ts "line one`nline two"'],
    ['Set-Content -Path "src/a.ts" -Value "x`ny"'],
    ['Add-Content own.md "note`nline"; Set-Content src/a.ts "x"'],
    ['Add-Content own.md "note`nline"; "x" > src/a.ts'],
    ['Add-Content own.md "note src/a.ts`nline"; Remove-Item src/a.ts'],
  ])('denies: %s', (text) => {
    expect(ps(text).kind).toBe('deny');
  });
});

describe('PowerShell backtick escapes: anything off the list keeps today\'s result', () => {
  it.each([
    // an escape that is not on the list (`e is ESC in PowerShell 7; `$ keeps a dollar out of expansion)
    ['Add-Content own.md "see src/a.ts `e[0m"'],
    ['Add-Content own.md "see src/a.ts `$x"'],
    ['Add-Content own.md "see src/a.ts `u{41}"'],
    // a backtick outside a double-quoted string (a line continuation) or in a single-quoted string
    ['Add-Content own.md `\n  -Value "see src/a.ts"'],
    ["Add-Content own.md -Value 'see src/a.ts `n'"],
    // one listed escape does not excuse an unlisted one in the same text
    ['Add-Content own.md "see src/a.ts `n and `e"'],
  ])('keeps the deny: %s', (text) => {
    expect(ps(text).kind).toBe('deny');
  });

  it('keeps every backtick as a risk sign for the Bash reading (no pwsh flag)', () => {
    expect(verdict('Add-Content own.md "see src/a.ts`nline"').kind).toBe('deny');
    expect(classifyShellText('Add-Content own.md "see src/a.ts`nline"', HELD, false, false).kind).toBe('deny');
  });
});
