# CCv3 Self-Improvement Research Loop -- daily wrapper (Windows Task Scheduler entry point).
# Picks the next component (round-robin), hands a headless CCv3 session a research /goal,
# and records the resulting proposal. RESEARCH + PROPOSE ONLY -- the headless session is
# constrained to a read + write-to-docs toolset and never edits code.
#
# Manual run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\self-improvement\run-research.ps1
$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\david.hayes\continuous-claude'
$si   = Join-Path $repo 'scripts\self-improvement'
Set-Location $repo

# claude -p must authenticate via the claude.ai subscription login, NOT the ANTHROPIC_API_KEY
# that is present in this environment (it is invalid / 401s and takes precedence over the login).
# Unset it for this process so the headless session falls back to the subscription. Harmless if unset.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

# Research-session scope guard [N3]: this unattended session writes ONLY to docs/self-improvement
# (prompt-fenced) and its claude -p allowlist below excludes every Notion MCP tool. As defence in
# depth, scrub NOTION_* from the environment so nothing downstream (including any ntn reached via the
# allowed Bash tool) can pick up a Notion token. ntn is not on PATH in this context; its keychain
# creds are deliberately left untouched but are unreachable without the absolute exe path, which the
# prompt never provides. Any future digest push to Notion MUST run in THIS parent process AFTER
# claude -p returns — never inside the subprocess.
Get-ChildItem Env: | Where-Object { $_.Name -like 'NOTION_*' } | ForEach-Object { Remove-Item "Env:$($_.Name)" -ErrorAction SilentlyContinue }

$date   = Get-Date -Format 'yyyy-MM-dd'
$logDir = Join-Path $repo '.claude\logs\self-improvement'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "$date.log"

# UTF-8 logging, Windows-PowerShell-5.1-COMPATIBLE (root-caused 2026-07-17):
# `Tee-Object -Encoding` is PowerShell 6+ ONLY. This task runs powershell.exe
# (5.1), where that parameter binding fails -- and under this wrapper's
# EAP='Stop' it killed the run on its first Log call (exit 1, no log: the
# 7/17 07:30 run). Tee-Log (Out-File -Encoding utf8) works under both 5.1
# and 7. Never reintroduce `Tee-Object -Encoding` under powershell.exe.
function Tee-Log {
  param([Parameter(ValueFromPipeline=$true)]$Line)
  process { $Line | Out-File -FilePath $log -Append -Encoding utf8; $Line }
}
function Log($msg) { "[$(Get-Date -Format o)] $msg" | Tee-Log }

Log "Self-improvement research run starting (date=$date)"

# 1) Deterministic round-robin component selection (advances state.json)
$componentJson = & node (Join-Path $si 'select-component.mjs')
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($componentJson)) {
  Log "ABORT: select-component.mjs failed (exit=$LASTEXITCODE)"; exit 1
}
$c = $componentJson | ConvertFrom-Json
Log "Selected component: $($c.id) -- $($c.name)"

# 2) Render the research goal prompt (literal string replacement, not regex)
$tpl = Get-Content -Raw (Join-Path $si 'research-goal.md')
$prompt = $tpl.
  Replace('{{DATE}}', $date).
  Replace('{{COMPONENT_ID}}', [string]$c.id).
  Replace('{{COMPONENT_NAME}}', [string]$c.name).
  Replace('{{COMPONENT_SUMMARY}}', [string]$c.summary).
  Replace('{{CURRENT_IMPL}}', (($c.currentImpl) -join ', ')).
  Replace('{{FRONTIER_HINTS}}', (($c.frontierHints) -join ', '))

$promptFile = Join-Path $env:TEMP "ccv3-si-prompt-$date.txt"
Set-Content -Path $promptFile -Value $prompt -Encoding utf8

# 3) Headless CCv3 research session. --allowedTools is an explicit allowlist:
#    read/search/write/bash/web/delegate/skill. Edit is intentionally EXCLUDED so the
#    session cannot modify existing code; destructive Bash is still blocked by the
#    destructive-command-guard hook. Prompt fences all writes to docs/self-improvement/.
Log "Invoking headless claude -p (allowlisted toolset)"
Get-Content -Raw $promptFile |
  & claude -p --allowedTools "Read,Grep,Glob,Write,Bash,WebSearch,WebFetch,Task,Skill" 2>&1 |
  Tee-Log
$claudeExit = $LASTEXITCODE
Log "claude -p exited (code=$claudeExit)"

# 4) Record the INDEX row deterministically (non-fatal if the proposal is missing)
& node (Join-Path $si 'record-index.mjs') $date $c.id 2>&1 | Tee-Log
$recordExit = $LASTEXITCODE

$proposal = "docs/self-improvement/proposals/$date-$($c.id).md"

# --- Report Runs registry (T3.6): non-fatal final step, in THIS parent PS process
# AFTER claude -p has exited. ntn authenticates via the OS keychain through its
# ABSOLUTE exe (NTN_EXE in lib/notion.mjs); the NOTION_* env scrub above (line ~25)
# does NOT touch keychain creds, so make-run + upsert still authenticate here.
# Status is synthesized DETERMINISTICALLY: OK if the proposal file was recorded
# (record-index succeeded and the file exists), else Warn. Non-fatal (try/catch) and
# the block does NOT change the script's existing exit semantics below. The script's
# EAP is 'Stop'; drop to 'Continue' locally so upsert's benign stderr (via 2>&1)
# cannot raise a NativeCommandError.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  # T6.1 #8: resolve an absolute node path for the registry make-run/upsert calls
  # (parity with the .bat wrappers under Task Scheduler's minimal PATH). Harmless
  # when bare node already resolves.
  $node = if (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { 'node' }
  # Artifact URL MUST be a durable http(s) URL — make-run's buildRun hard-rejects a
  # local filesystem path (it stops resolving once the run's temp workspace is cleaned,
  # and Notion's url property rejects non-URLs). Passing $proposal here (the old bug)
  # made make-run THROW inside this non-fatal try/catch, so the run exited 0 while
  # silently landing NO registry row. Emit the Self-Improvement child-page Notion URL
  # instead (single source of truth = report-runs.ids.json childPages); keep the local
  # proposal path in the human-readable summary as a breadcrumb.
  $ids   = Get-Content (Join-Path $repo 'scripts\report-registry\report-runs.ids.json') -Raw | ConvertFrom-Json
  $siId  = ($ids.childPages.'Self-Improvement') -replace '-', ''
  $artifact = "https://www.notion.so/$siId"
  if (Test-Path $proposal) {
    $siStatus = 'OK'; $verdict = "proposal recorded ($proposal)"
  } else {
    $siStatus = 'Warn'; $verdict = "no proposal (record-index exit=$recordExit); see docs/self-improvement/INDEX.md"
  }
  $emit = & $node (Join-Path $repo 'scripts\report-registry\make-run.mjs') `
    --type 'Self-Improvement' --source 'Self-Improvement' --period $date --status $siStatus `
    --artifactUrl $artifact --summary "$($c.id): $verdict" 2>&1
  # make-run prints the emitted run-JSON PATH on stdout and a preamble on stderr; 2>&1
  # merges both so a THROW (e.g. a future URL-guard regression) is captured in the log
  # instead of being swallowed silently — this silent-swallow is exactly what hid the bug.
  $makeRunExit = $LASTEXITCODE
  # The stdout PATH line is a bare path (no whitespace); the stderr preamble
  # ("[report-registry] emitted run ... -> <path>.json") also ends in .json, so match
  # only a whitespace-free .json line to avoid picking the preamble.
  $runPath = ($emit | ForEach-Object { "$_".Trim() } |
    Where-Object { $_ -match '\.json$' -and $_ -notmatch '\s' } | Select-Object -Last 1)
  if ($makeRunExit -eq 0 -and $runPath) {
    Log "make-run SUCCEEDED (exit=0) -> $runPath"
    & $node (Join-Path $repo 'scripts\report-registry\upsert.mjs') $runPath 2>&1 |
      ForEach-Object { "$_" } | Tee-Log
    Log "report-run upsert exit=$LASTEXITCODE (non-fatal)"
  } else {
    Log "make-run FAILED or emitted no path (exit=$makeRunExit) -- skipping upsert. Output: $($emit -join ' | ')"
  }
} catch {
  Log "report-run registry step threw (non-fatal): $_"
} finally {
  $ErrorActionPreference = $prevEAP
}

if ($recordExit -eq 0) {
  Log "Done. Proposal: $proposal"
  exit 0
} else {
  Log "WARN: proposal not recorded (record-index exit=$recordExit). Check the log + $proposal."
  exit $recordExit
}
