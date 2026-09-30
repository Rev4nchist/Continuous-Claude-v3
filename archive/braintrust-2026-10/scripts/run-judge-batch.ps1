# run-judge-batch.ps1 — daily Braintrust judge batch (Gate C, Phase 3b)
#
# Scheduled via Windows Task Scheduler job "CCv3-Judge-Batch" (daily 06:15).
# Runs judge_session.py against sessions since the previous day.
#
# MUST run locally: the judges use codex/claude subscription-OAuth CLIs
# (no API keys), which only exist on this machine. A remote /schedule
# routine or a Braintrust UI rule cannot invoke them.
#
# Inspect / control:
#   schtasks /query  /tn "CCv3-Judge-Batch" /v /fo list
#   schtasks /run    /tn "CCv3-Judge-Batch"          # trigger a live run now
#   schtasks /delete /tn "CCv3-Judge-Batch" /f       # remove
# Log: .claude/logs/judge-batch.log

# Was "Stop": with the '2>&1 |' pipeline below, a native stderr write raised a terminating
# NativeCommandError that aborted the script BEFORE logging the real exit code — the root cause
# of the recurring 0x80070001 self-aborts (empty log + missing END line). "Continue" + capture-first.
$ErrorActionPreference = "Continue"

$repo    = "C:\Users\david.hayes\continuous-claude"
$opc     = Join-Path $repo "opc"
$logDir  = Join-Path $repo ".claude\logs"
$logFile = Join-Path $logDir "judge-batch.log"
$since   = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")

# Resolve uv (PATH may differ under Task Scheduler)
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) { $uv = "C:\Users\david.hayes\AppData\Local\Programs\Python\Python313\Scripts\uv.exe" }

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }

function Write-Log($msg) {
    $stamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
    Add-Content -Path $logFile -Value "[$stamp] $msg"
}

Write-Log "START judge batch --scan-since $since --max-sessions 10 (uv: $uv)"

Set-Location $opc
# Capture BEFORE logging so a native stderr write can't abort the script mid-pipeline (which
# previously destroyed the log and masked the real exit code). This always reaches the END line.
$out  = & $uv run python -m scripts.core.judge_session --scan-since $since --max-sessions 10 2>&1
$code = $LASTEXITCODE
$out | ForEach-Object { Add-Content -Path $logFile -Value $_ }

# Zero-post ratchet (2026-09-23 Opus 5.5 eval, P32). Across 102 runs the judges posted 22 scores
# and exited 0 every day, so the scheduler showed green while the eval layer measured nothing.
# If sessions were sampled but nothing was posted, exit 3 so the registry and dashboard show it.
#
# 2026-09-24 (P32): the three judges were retired and JUDGE_REGISTRY ships empty, so every
# sampled session now legitimately posts 0 -- judge_session.py marks that with a "retired" key
# in its JSON output. Retired-and-zero is expected and must NOT trip the ratchet; judges that
# ARE registered and still post 0 must still trip it.
$text    = ($out | Out-String)
$retired = $text -match '"retired":'
$sampled = ([regex]::Matches($text, '"sampled":\s*true')).Count
$posted  = ([regex]::Matches($text, '"posts":\s*[1-9]')).Count
if ($retired) {
    Write-Log "RETIRED: judges retired (P32, 2026-09-24), nothing to post"
} elseif ($code -eq 0 -and $sampled -gt 0 -and $posted -eq 0) {
    Write-Log "ZERO-POST: $sampled session(s) sampled, 0 judge scores posted -- the judges measured nothing"
    $code = 3
}

Write-Log "END exit=$code"
exit $code
