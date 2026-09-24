# Weekly rule-router false-fire review (Task Scheduler: CCv3-RuleRouter-Review, Mondays 09:20).
# Runs under Windows PowerShell 5.1 (powershell.exe): no PS7-only syntax here.
#   1. Makes sure today's audit report exists (runs the audit if the 09:07 task has not).
#   2. Judges this week's fires and adds false fires to ~/.claude/logs/rule-router-false-fires.jsonl.
#   3. Creates this week's review page under Dave's Notion Scratchpad (where he looks on Mondays).
# Exit code = 1 if the judge call or the Notion page failed (the log and the report say which).
$R = 'C:\Users\david.hayes\continuous-claude'
$node = 'C:\Program Files\nodejs\node.exe'
$scratchpad = '1f576fd7ac82807ab8c3f03b2002d40c'   # Dave's Scratchpad; this job only CREATES one page a week
$log = Join-Path $R '.claude\logs\rule-router-review.log'
$day = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')   # the scripts name reports by UTC date
$report = Join-Path $R "docs\self-improvement\audits\rule-router-$day.md"
function Write-Log([string]$m) { Add-Content -Path $log -Value "[$(Get-Date -Format s)] $m" }

Write-Log 'review starting'
Set-Location $R
# Subscription auth for the headless judge: an API key in the environment would switch billing.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

$auditRc = 0
if (-not (Test-Path $report)) {
  Write-Log 'no audit report for today yet: running the audit first'
  & $node scripts\rules\rule-router-audit.mjs --days 7 2>&1 | ForEach-Object { Write-Log "$_" }
  $auditRc = $LASTEXITCODE   # keep it: the review below would overwrite $LASTEXITCODE
}

& $node scripts\rules\rule-router-false-fires.mjs review --days 7 --notion-parent $scratchpad 2>&1 | ForEach-Object { Write-Log "$_" }
$reviewRc = $LASTEXITCODE
$rc = if ($reviewRc -ne 0) { $reviewRc } else { $auditRc }
Write-Log "review finished, audit exit $auditRc, review exit $reviewRc, task exit $rc"
exit $rc
