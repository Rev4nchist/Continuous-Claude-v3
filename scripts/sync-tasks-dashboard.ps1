# CCv3 Scheduled-Tasks dashboard daily refresh.
# Registered as the "CCv3-Dashboard-Sync" task (daily 20:00). Pipes the refresh prompt into a headless
# claude -p that re-inventories the tasks (Get-ScheduledTask) and updates the Notion "Reports" dashboard
# (page 38f76fd7...) via the claude.ai Notion MCP -- reachability proven 2026-06-30.
#
# Manual run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-tasks-dashboard.ps1
$ErrorActionPreference = 'Continue'

$repo = 'C:\Users\david.hayes\continuous-claude'
Set-Location $repo

# claude -p must auth via the claude.ai subscription login (the Notion MCP rides that OAuth), NOT a
# stale ANTHROPIC_API_KEY in the environment.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

$date   = Get-Date -Format 'yyyy-MM-dd'
$logDir = Join-Path $repo '.claude\logs\dashboard-sync'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log    = Join-Path $logDir "$date.log"
$prompt = Join-Path $repo 'scripts\sync-tasks-dashboard-prompt.md'

# UTF-8 logging, Windows-PowerShell-5.1-COMPATIBLE (root-caused 2026-07-17):
# `Tee-Object -Encoding` is PowerShell 6+ ONLY. This task runs powershell.exe
# (5.1), where the parameter binding fails; under this wrapper's EAP='Continue'
# the failure was WORSE than a crash -- each pipeline STATEMENT that piped into
# Tee-Object silently never executed (binding fails before the pipeline starts),
# so the claude sync step itself could no-op while the wrapper exited 0.
# Tee-Log (Out-File -Encoding utf8) works under both 5.1 and 7. Never
# reintroduce `Tee-Object -Encoding` in a wrapper that powershell.exe runs.
function Tee-Log {
  param([Parameter(ValueFromPipeline=$true)]$Line)
  process { $Line | Out-File -FilePath $log -Append -Encoding utf8; $Line }
}
# --- ALWAYS-EMIT registry contract (root-caused 2026-07-25) ----------------------
# THE BUG THIS FIXES: the registry emit sat AFTER claude -p, so a run killed during
# it left the period with ZERO rows and the watchdog reported a silent miss --
# indistinguishable from a run that never launched. That is exactly the 2026-07-23
# miss: this wrapper logged "dashboard-sync starting" and nothing else, because
# claude -p hung and the task's PT1H ExecutionTimeLimit killed the whole process.
# Emit a PESSIMISTIC row FIRST, then update it in place. Both emits pass the SAME
# --runDate ($runStamp) and make-run derives runId = "<type>|<period>|<runDate>",
# so upsert (which queries by Run ID) updates ONE row instead of duplicating.
$runStamp = (Get-Date).ToUniversalTime().ToString('o')
$node = if (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { 'node' }

function Write-RunRow($status, $summary) {
  try {
    $emit = & $node (Join-Path $repo 'scripts\report-registry\make-run.mjs') `
      --type 'Team Dashboard' --source 'Dashboard-Sync' --period $date --runDate $runStamp `
      --status $status --artifactUrl 'https://www.notion.so/38f76fd7ac8280478e50dd2956ba6e8a' `
      --summary $summary
    $emit = ($emit | Select-Object -Last 1)
    if ($LASTEXITCODE -eq 0 -and $emit) {
      & $node (Join-Path $repo 'scripts\report-registry\upsert.mjs') $emit 2>&1 |
        ForEach-Object { "$_" } | Tee-Log
      "[$(Get-Date -Format o)] report-run upsert exit=$LASTEXITCODE status=$status (non-fatal)" | Tee-Log
    } else {
      "[$(Get-Date -Format o)] make-run emitted no path (exit=$LASTEXITCODE) -- skipping upsert" | Tee-Log
    }
  } catch {
    "[$(Get-Date -Format o)] report-run registry step threw (non-fatal): $_" | Tee-Log
  }
}

"[$(Get-Date -Format o)] dashboard-sync starting" | Tee-Log

# PESSIMISTIC PRE-EMIT -- survives a hard kill during the long call below.
# Keep this string pure ASCII: this file has no BOM, so powershell.exe 5.1 decodes
# it as CP1252 and a UTF-8 em-dash inside a DOUBLE-QUOTED string becomes a smart
# quote that terminates the string early (comments are unaffected).
Write-RunRow 'Failed' "in-progress - claude -p invoked at $runStamp. Updated in place on completion; if it still reads Failed the run was killed or aborted before finishing (see .claude/logs/dashboard-sync/$date.log)."

# BOUNDED claude -p. The old unbounded pipe could ride the task's PT1H limit to a
# silent death (2026-07-23). Start-Process gives a ceiling we control; the prompt is
# fed from $prompt via stdin redirection and output is captured to files, then logged.
# Healthy runs take ~3 min, so 30 min is generous while staying inside PT1H.
$syncTimeoutSec = if ($env:CCV3_DASH_TIMEOUT_SEC) { [int]$env:CCV3_DASH_TIMEOUT_SEC } else { 1800 }
$outFile = Join-Path $env:TEMP "ccv3-dash-out-$date.txt"
$errFile = Join-Path $env:TEMP "ccv3-dash-err-$date.txt"
$code = -1
$syncTimedOut = $false
try {
  $proc = Start-Process -FilePath 'C:\Users\david.hayes\.local\bin\claude.exe' `
    -ArgumentList '-p', '--allowedTools', 'Bash,ReadMcpResourceTool,mcp__claude_ai_Notion__notion-fetch,mcp__claude_ai_Notion__notion-update-page' `
    -RedirectStandardInput $prompt -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
    -NoNewWindow -PassThru
  # Touch .Handle so .ExitCode remains readable after exit (PS -PassThru quirk).
  $null = $proc.Handle
  if (-not $proc.WaitForExit($syncTimeoutSec * 1000)) {
    $syncTimedOut = $true
    "[$(Get-Date -Format o)] TIMEOUT: claude -p exceeded ${syncTimeoutSec}s -- killing it so the registry emit below still runs" | Tee-Log
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    try { $proc.WaitForExit(15000) | Out-Null } catch { }
  } else {
    $code = $proc.ExitCode
  }
  foreach ($f in @($outFile, $errFile)) {
    if (Test-Path $f) { Get-Content $f -ErrorAction SilentlyContinue | Tee-Log | Out-Null }
  }
} catch {
  "[$(Get-Date -Format o)] claude -p launch threw (captured): $_" | Tee-Log
}
"[$(Get-Date -Format o)] dashboard-sync finished (exit=$code, timedOut=$syncTimedOut)" | Tee-Log

# --- Post-write verification (non-fatal, read-only): confirm the write actually
# landed server-side before the registry records OK. A `claude -p` exit=0 proves
# the session finished, not that the Notion write happened (a no-op/skip inside
# the session still exits 0). Read the page back via ntn (stdin closed -> no
# hang, per notion-cli-safety.md) and look for the section's own capture-stamp
# marker line (sync-tasks-dashboard-prompt.md step 4: the italic
# "*Statuses below captured <date>*" line) carrying TODAY's date.
$verifyOk = $false
$verifyReason = 'not-attempted'
if ($code -eq 0) {
  try {
    $ntnExe = 'C:/Users/david.hayes/AppData/Local/Microsoft/WinGet/Packages/Notion.ntn_Microsoft.Winget.Source_8wekyb3d8bbwe/ntn-x86_64-pc-windows-msvc/ntn.exe'
    $pageId = '38f76fd7ac8280478e50dd2956ba6e8a'
    if (-not (Test-Path $ntnExe)) {
      $verifyReason = "ntn.exe not found at $ntnExe"
    } else {
      $psi = [System.Diagnostics.ProcessStartInfo]::new()
      $psi.FileName = $ntnExe
      foreach ($a in @('pages', 'get', $pageId)) { $psi.ArgumentList.Add($a) }
      $psi.RedirectStandardInput = $true
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      $psi.UseShellExecute = $false
      $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
      $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
      $p = [System.Diagnostics.Process]::Start($psi)
      $p.StandardInput.Close() # EOF on stdin -- prevents the documented ntn open-stdin hang
      $outTask = $p.StandardOutput.ReadToEndAsync()
      $errTask = $p.StandardError.ReadToEndAsync()
      if (-not $p.WaitForExit(30000)) {
        try { $p.Kill($true) } catch {}
        $verifyReason = 'ntn pages get timed out after 30000ms'
      } else {
        $pageMd = $outTask.GetAwaiter().GetResult()
        $ntnErr = $errTask.GetAwaiter().GetResult()
        if ($p.ExitCode -ne 0) {
          $verifyReason = "ntn pages get exit=$($p.ExitCode): $ntnErr"
        } else {
          $markerLine = ($pageMd -split "`r?`n") | Where-Object { $_ -match 'Statuses below captured' } | Select-Object -First 1
          # Accept either date rendering the prompt might produce -- ISO (yyyy-MM-dd,
          # what $date already is) or a humanized "d MMM yyyy" -- rather than assume
          # one exact literal format never drifts.
          $todayHuman = Get-Date -Format 'd MMM yyyy'
          if ($markerLine -and ($markerLine -match [regex]::Escape($date) -or $markerLine -match [regex]::Escape($todayHuman))) {
            $verifyOk = $true
            $verifyReason = 'capture stamp confirmed'
          } elseif ($markerLine) {
            $verifyReason = "capture stamp stale/unrecognized: $markerLine"
          } else {
            $verifyReason = 'capture-stamp marker line not found on page'
          }
        }
      }
    }
  } catch {
    $verifyReason = "verify threw (non-fatal): $_"
  }
} else {
  $verifyReason = "claude -p exited nonzero ($code) -- skipped verify"
}
"[$(Get-Date -Format o)] post-write verify: ok=$verifyOk reason=$verifyReason" | Tee-Log

# --- Report Runs registry (T3.4): non-fatal final step. --------------------------
# Status is synthesized DETERMINISTICALLY from the captured exit code AND the
# post-write verification above (0 exit alone is NOT sufficient for OK -- a
# verify failure records Warn with the verify reason so a silent no-op doesn't
# read as a healthy sync).
# This UPDATES the pessimistic pre-emit row in place (same $runStamp => same runId),
# so a healthy day still ends with exactly one row. A timeout is Failed, not Warn:
# it produced no verified write at all, and defaulting to the worse state matches the
# health-check wrapper's exit-code mapping convention (T6.1 #3).
$status = if ($syncTimedOut) { 'Failed' } elseif ($code -eq 0 -and $verifyOk) { 'OK' } else { 'Warn' }
$summary = if ($syncTimedOut) {
  "claude -p exceeded the ${syncTimeoutSec}s timeout and was killed; no verified write"
} else {
  "scheduled-tasks section refreshed (exit=$code); verify: $verifyReason"
}
Write-RunRow $status $summary

# --- Silent-miss watchdog (T5): non-fatal final step, NEVER touches $code. -------
# Sweeps ALL 6 report types (not just Team Dashboard's own row above) -- checks
# each type's expected-period-by-deadline+grace and upserts a Failed miss-row
# when a scheduled run never launched or was killed mid-flight, leaving ZERO
# registry rows (the append-per-attempt model otherwise makes that absence
# invisible). Real run (writes miss-rows when it finds one); wrapped in
# try/catch and its own exit code is only logged, never propagated, so a
# watchdog outage can NEVER change $code or this task's Last Run Result.
try {
  & $node (Join-Path $repo 'scripts\report-registry\watchdog.mjs') 2>&1 |
    ForEach-Object { "$_" } | Tee-Log
  "[$(Get-Date -Format o)] watchdog sweep exit=$LASTEXITCODE (non-fatal)" | Tee-Log
} catch {
  "[$(Get-Date -Format o)] watchdog sweep threw (non-fatal): $_" | Tee-Log
}

# X3 fix: the script previously logged $LASTEXITCODE but never `exit`ed with it, so
# Task Scheduler always recorded success. Exit with the captured claude -p code so
# the scheduler's Last Run Result and the registry Status agree on the outcome.
# A timeout normalizes to 1 rather than the -1 sentinel, so the scheduler shows a
# plain failure instead of 0xFFFFFFFF.
if ($syncTimedOut) { exit 1 }
exit $code
