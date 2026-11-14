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

describe('platform and case', () => {
  it('folds case on a case-folding platform for a data string too', () => {
    expect(verdict('Add-Content log.md "see SRC/A.TS"', true).kind).not.toBe('deny');
    expect(verdict('Set-Content SRC/A.TS "x"', true).kind).toBe('deny');
  });
});
