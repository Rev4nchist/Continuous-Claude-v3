# Weekly rule-router false-fire review (Task Scheduler: CCv3-RuleRouter-Review, Mondays 09:20).
# Runs under Windows PowerShell 5.1 (powershell.exe): no PS7-only syntax here.
#   1. Makes sure today's audit report exists (runs the audit if the 09:07 task has not).
#   2. Judges this week's fires and adds false fires to ~/.claude/logs/rule-router-false-fires.jsonl.
#   3. Creates this week's review page under Dave's Notion Scratchpad (where he looks on Mondays).
# Exit code = 1 if the judge call or the Notion page failed (the log and the report say which).
#
# This file lives in the repo at .claude/scripts/scheduled/ and the forward sync installs it at
# ~/.claude/scripts/scheduled/. The task points at the installed copy. The scripts it runs live in the
# repo (scripts\rules\) and are not synced, so this file finds the repo root first:
#   CCV3_RULE_ROUTER_REPO_ROOT (override) > machine profile REPO_ROOT > the default checkout.
# CCV3_RULE_ROUTER_LOG overrides the log path (default ~/.claude/logs/rule-router-review.log).
$scratchpad = '1f576fd7ac82807ab8c3f03b2002d40c'   # Dave's Scratchpad; this job only CREATES one page a week

$logPath = if ($env:CCV3_RULE_ROUTER_LOG) { $env:CCV3_RULE_ROUTER_LOG } else { Join-Path $env:USERPROFILE '.claude\logs\rule-router-review.log' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
function Write-Log([string]$m) { Add-Content -Path $logPath -Value "[$(Get-Date -Format s)] $m" }

# node: PATH first, then the default install (Task Scheduler's PATH is not the user's PATH).
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }

# The repo copy of this file is three folders below the repo root. The installed copy is not.
$boot = if ($PSScriptRoot) { [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..')) } else { '' }
$profileScript = if ($boot) { Join-Path $boot 'scripts\settings\machine-profile.mjs' } else { '' }
if (-not ($profileScript -and (Test-Path $profileScript))) {
  $boot = Join-Path $env:USERPROFILE 'continuous-claude'
  $profileScript = Join-Path $boot 'scripts\settings\machine-profile.mjs'
}
$R = $boot
foreach ($line in @(& $node $profileScript --export bat --quiet 2>$null)) {
  if ("$line" -match '^REPO_ROOT=(.+)$') { $R = $Matches[1].Trim() }
}
if ($env:CCV3_RULE_ROUTER_REPO_ROOT) { $R = $env:CCV3_RULE_ROUTER_REPO_ROOT }   # last, so it wins over the profile

$branch = 'unknown'
try { $b = (& git -C $R rev-parse --abbrev-ref HEAD 2>$null); if ($LASTEXITCODE -eq 0 -and $b) { $branch = "$b".Trim() } } catch { }

$day = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')   # the scripts name reports by UTC date
$report = Join-Path $R "docs\self-improvement\audits\rule-router-$day.md"

Write-Log "review starting, repo $R, branch $branch"
Set-Location $R
# Subscription auth for the headless judge: an API key in the environment would switch billing.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

$auditRc = 0
if (-not (Test-Path $report)) {
  Write-Log 'no audit report for today yet: running the audit first'
  $auditLines = @(& $node scripts\rules\rule-router-audit.mjs --days 7 2>&1)
  $auditRc = $LASTEXITCODE   # keep it: the review below would overwrite $LASTEXITCODE
  $auditLines | ForEach-Object { Write-Log "$_" }
  $m = [regex]::Match(($auditLines -join "`n"), '(\d+) dedupe breaks')
  if ($m.Success) { Write-Log "Dedupe breaks: $($m.Groups[1].Value)" } else { Write-Log 'Dedupe breaks: unknown (no audit summary line)' }
}

& $node scripts\rules\rule-router-false-fires.mjs review --days 7 --notion-parent $scratchpad 2>&1 | ForEach-Object { Write-Log "$_" }
$reviewRc = $LASTEXITCODE
$rc = if ($reviewRc -ne 0) { $reviewRc } else { $auditRc }
Write-Log "review finished, audit exit $auditRc, review exit $reviewRc, task exit $rc"
exit $rc
