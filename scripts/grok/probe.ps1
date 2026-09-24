# Bounded Grok inference probe — safe to run any time; never hangs, never leaves orphans.
# Usage:  pwsh -NoProfile -File scripts/grok/probe.ps1 [-TimeoutSec 60]
# You should see either the model's reply (Grok inference is UP) or "HUNG >Ns" (still stalled).
#
# Discipline (see .claude/rules-ondemand/grok-worker-safety.md + the 2026-07-12 grok-diagnosis handoff):
# - Bounded: Wait-Job caps the call; a raw `grok -p` can hang indefinitely (intermittent
#   pre-first-token completion stall, observed 2026-07-12/13).
# - Swept: Stop-Process kills the native grok.exe orphan (GNU timeout CANNOT — verified).
# - Paced: if probing repeatedly, space probes >=4 min apart; each may burn Premium+ quota.
param(
  [int]$TimeoutSec = 60,
  [string]$Prompt = "Reply with exactly: READY"
)
if (-not $env:HOME) { $env:HOME = $env:USERPROFILE }
Remove-Item Env:XAI_API_KEY -ErrorAction SilentlyContinue   # force the OAuth subscription path

$t0 = Get-Date
$job = Start-Job { param($p) & grok -p $p --no-auto-update --output-format json 2>&1 } -ArgumentList $Prompt
$done = Wait-Job $job -Timeout $TimeoutSec
$elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
if (-not $done) { Stop-Job $job }
$out = (Receive-Job $job -ErrorAction SilentlyContinue | Out-String)

if ($done) {
  Write-Output "GROK PROBE ts=$($t0.ToString('yyyy-MM-dd HH:mm:ss')) RETURNED in ${elapsed}s:"
  Write-Output $out
} else {
  Write-Output "GROK PROBE ts=$($t0.ToString('yyyy-MM-dd HH:mm:ss')) HUNG >${TimeoutSec}s (completion path still stalled)"
}

Remove-Job $job -Force
Get-Process grok* -ErrorAction SilentlyContinue | Stop-Process -Force
exit $(if ($done) { 0 } else { 1 })
