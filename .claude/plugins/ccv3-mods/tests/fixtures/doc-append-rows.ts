// The row table of isDocAppend (lane coord-guard-text-false-refusal, seat ruling 2026-11-23 12:48 CST, condition 5).
// ONE source for both copies of the test: the plugin test imports it (tests/doc-append.test.ts); the hook test reads this file as text and parses the
// JSON array after the first "= [" (src/__tests__/doc-append-drift.test.ts in .claude/hooks). Keep the array valid JSON: double quotes, no comments inside, no trailing comma.
export const DOC_APPEND_ROWS: ReadonlyArray<{ want: boolean; segment: string }> = [
 {
  "want": true,
  "segment": "Add-Content -LiteralPath .claudedocs/x.md -Value 'seat: a note'"
 },
 {
  "want": true,
  "segment": "Add-Content -LiteralPath 'C:\\Users\\dkhay\\continuous-claude\\.claudedocs\\coordination\\milestones\\re-program.md' -Value 'a note'"
 },
 {
  "want": true,
  "segment": "Add-Content -Path notes.txt -Value 'a note'"
 },
 {
  "want": true,
  "segment": "Set-Content -LiteralPath a.log -Value 'a note'"
 },
 {
  "want": true,
  "segment": "Add-Content -LiteralPath x.md 'a note'"
 },
 {
  "want": true,
  "segment": "add-content -literalpath X.MD -value 'a note'"
 },
 {
  "want": true,
  "segment": "Add-Content -LiteralPath x.ps1.md -Value 'a note'"
 },
 {
  "want": true,
  "segment": "  Add-Content -LiteralPath x.md -Value 'a note'  "
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath run.ps1 -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath run.mjs -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath run.cmd -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md.ps1 -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath notes -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.json -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath $p -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath \"x.md\" -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value \"a note\""
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value \"$t a note\""
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value $e"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value @('', 'a note')"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value (Get-Date)"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value $(Get-Date)"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value @'\na note\n'@"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value 'a note' > run.ps1"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value 'a note' -Stream y"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value 'a note' -Encoding UTF8"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md,run.ps1 -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Path y.md -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath ..\\x.md -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath a/../x.md -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -Path *.md -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -Path x?.md -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -Path [a]x.md -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value 'a note' extra"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md"
 },
 {
  "want": false,
  "segment": "Add-Content -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value 'it''s a note'"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath x.md -Value 'a note'`n"
 },
 {
  "want": false,
  "segment": "Add-Content -LiteralPath –x.md -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Add-Content –LiteralPath x.md -Value 'a note'"
 },
 {
  "want": false,
  "segment": "ac -LiteralPath x.md -Value 'a note'"
 },
 {
  "want": false,
  "segment": "sc -LiteralPath x.md -Value 'a note'"
 },
 {
  "want": false,
  "segment": "Out-File -LiteralPath x.md -InputObject 'a note'"
 },
 {
  "want": false,
  "segment": "Tee-Object -FilePath x.md"
 },
 {
  "want": false,
  "segment": "echo 'a note'"
 },
 {
  "want": false,
  "segment": "pwsh -File scripts/github/land-pr.ps1 -Pr 12"
 },
 {
  "want": false,
  "segment": ""
 }
]
