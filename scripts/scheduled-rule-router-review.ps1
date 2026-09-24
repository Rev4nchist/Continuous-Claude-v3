# Weekly rule-router false-fire review + reminder (Task Scheduler: CCv3-RuleRouter-Review, Mondays 09:20).
# Runs under Windows PowerShell 5.1 (powershell.exe): no PS7-only syntax here.
#   1. Makes sure today's audit report exists (runs the audit if the 09:07 task has not).
#   2. Judges this week's fires and adds false fires to ~/.claude/logs/rule-router-false-fires.jsonl.
#   3. Shows a Windows notification that the audit and the review are ready.
# Exit code = the review's (1 = the judge call failed; the report says so).
$R = 'C:\Users\david.hayes\continuous-claude'
$node = 'C:\Program Files\nodejs\node.exe'
$log = Join-Path $R '.claude\logs\rule-router-review.log'
$day = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')   # the scripts name reports by UTC date
$report = Join-Path $R "docs\self-improvement\audits\rule-router-$day.md"
function Write-Log([string]$m) { Add-Content -Path $log -Value "[$(Get-Date -Format s)] $m" }

Write-Log 'review starting'
Set-Location $R
# Subscription auth for the headless judge: an API key in the environment would switch billing.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

if (-not (Test-Path $report)) {
  Write-Log 'no audit report for today yet: running the audit first'
  & $node scripts\rules\rule-router-audit.mjs --days 7 2>&1 | ForEach-Object { Write-Log "$_" }
}

$out = & $node scripts\rules\rule-router-false-fires.mjs review --days 7 2>&1
$rc = $LASTEXITCODE
$out | ForEach-Object { Write-Log "$_" }
$summary = ($out | Select-String 'false-fire review:' | Select-Object -Last 1)
$summary = if ($summary) { $summary.Line -replace '^false-fire review:\s*', '' } else { 'no summary line' }

$title = if ($rc -eq 0) { 'Rule-router audit ready' } else { 'Rule-router review FAILED' }
$body = "$summary. Report: docs\self-improvement\audits\rule-router-$day.md"
& (Join-Path $R 'scripts\notify-toast.ps1') -Title $title -Body $body | ForEach-Object { Write-Log "$_" }
Write-Log "review finished, exit $rc"
exit $rc
