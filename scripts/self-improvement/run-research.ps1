# CCv3 Self-Improvement Research Loop -- daily wrapper (Windows Task Scheduler entry point).
# Picks the next component (round-robin), hands a headless CCv3 session a research /goal,
# and records the resulting proposal. RESEARCH + PROPOSE ONLY -- the headless session is
# constrained to a read + write-to-docs toolset and never edits code.
#
# Manual run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\self-improvement\run-research.ps1
$ErrorActionPreference = 'Stop'

$repo = (Join-Path $env:USERPROFILE 'continuous-claude')
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

# --- ALWAYS-EMIT registry contract (root-caused 2026-07-25) ----------------------
# THE BUG THIS FIXES: the registry emit used to be the LAST step of this script, so
# ANY failure upstream of it left the period with ZERO rows. The watchdog then
# reported a "silent miss" — indistinguishable from a run that never launched —
# even though the run HAD executed. Six of the nine open miss-rows as of 2026-07-25
# were this class: 07-21/07-24 (claude -p hung, task killed mid-flight), 07-22
# (API "Connection closed mid-response" -> EAP='Stop' aborted the script), and
# 07-17..07-19 (a since-fixed make-run artifact-URL bug, commit 0c58413).
#
# THE CONTRACT: emit a PESSIMISTIC row BEFORE the long call, then UPDATE it in place
# after. Both emits pass the SAME --runDate ($runStamp); make-run derives
# runId = "<type>|<period>|<runDate>", and upsert queries by Run ID before creating,
# so the two emits resolve to ONE row (update, not duplicate). If the process is
# hard-killed anywhere in between, the pessimistic row SURVIVES — the period reads
# Failed with a breadcrumb of where it died, instead of being silently absent.
# Defaulting to the worse state mirrors the health-check wrapper's exit-code mapping
# convention (T6.1 #3). After this change, a genuine watchdog silent-miss can only
# mean "the task never launched at all" — which is the one case a rerun would help.
$runStamp = (Get-Date).ToUniversalTime().ToString('o')

# Artifact URL is resolved + validated ONCE, up front, so the pre-emit below cannot
# be the thing that discovers a broken id. Same 32-hex guard as before: a bare
# "https://www.notion.so/" would pass make-run's http(s) check while linking nowhere.
$ids  = Get-Content (Join-Path $repo 'scripts\report-registry\report-runs.ids.json') -Raw | ConvertFrom-Json
$siId = ($ids.childPages.'Self-Improvement') -replace '-', ''
if ($siId -notmatch '^[0-9a-f]{32}$') {
  throw "Self-Improvement child-page id missing/invalid in report-runs.ids.json (got '$siId') -- refusing to emit a meaningless artifact URL"
}
$artifact = "https://www.notion.so/$siId"

# Emit (or re-emit) THIS run's registry row. Non-fatal by contract: a registry
# problem must never change the research run's own exit semantics. EAP is dropped to
# 'Continue' locally so the node calls' benign stderr (merged via 2>&1) cannot raise
# a NativeCommandError under this script's EAP='Stop'.
function Write-RunRow($status, $summary) {
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    # Absolute node path: Task Scheduler's minimal PATH does not include node.
    $node = if (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { 'node' }
    # MIGRATED to emit-run.mjs 2026-08-31. This was the copy that "got it right"
    # (the local EAP save/lower/restore around it, kept below), but it was still
    # TWO chained native commands plus a hand-rolled stdout parse that had to
    # distinguish make-run's path line from its stderr preamble by "has no
    # whitespace". emit-run.mjs runs make-run and upsert in ONE process and its
    # contract #1 guarantees exactly one stdout line, so the heuristic goes away
    # with the second process that made it necessary.
    # --json is passed so the log records `action` (created vs updated) -- the
    # evidence that update-in-place actually happened.
    $emit = & $node (Join-Path $repo 'scripts\report-registry\emit-run.mjs') `
      --type 'Self-Improvement' --source 'Self-Improvement' --period $date --runDate $runStamp `
      --status $status --artifactUrl $artifact --summary $summary --json 2>&1
    $emitExit = $LASTEXITCODE
    $emit | ForEach-Object { "$_" } | Tee-Log
    if ($emitExit -eq 0) {
      Log "report-run emit SUCCEEDED (exit=0, status=$status)"
    } else {
      Log "report-run emit FAILED (exit=$emitExit) -- no row landed. Output: $($emit -join ' | ')"
    }
  } catch {
    Log "report-run registry step threw (non-fatal): $_"
  } finally {
    $ErrorActionPreference = $prevEAP
  }
}

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

# PESSIMISTIC PRE-EMIT (always-emit contract, see above). Written BEFORE the long
# call so a hard kill during it still leaves a visible, self-explaining row.
# NOTE: keep this string pure ASCII. This file has no BOM, so powershell.exe 5.1
# decodes it as CP1252; a UTF-8 em-dash inside a DOUBLE-QUOTED string decodes to a
# smart quote that terminates the string early and breaks the parse (comments are
# unaffected, which is why the existing em-dashes above are safe).
Write-RunRow 'Failed' "$($c.id): in-progress - claude -p invoked at $runStamp. This row is updated in place on completion; if it still reads Failed, the run was killed or aborted before finishing (see .claude/logs/self-improvement/$date.log)."

# The headless call is BOUNDED. On 07-21 and 07-24 it hung with no output and rode
# the task's PT3H ExecutionTimeLimit to a silent death, burning the whole day's slot.
# Start-Process + WaitForExit(ms) gives a hard ceiling we control; stdin comes from
# $promptFile (no TTY inheritance) and stdout/stderr are captured to files, then
# appended to the log. Successful runs have taken 20-24 min, so 45 min is generous
# while leaving hours of headroom inside PT3H for the emit + triage steps below.
$claudeTimeoutSec = if ($env:CCV3_SI_TIMEOUT_SEC) { [int]$env:CCV3_SI_TIMEOUT_SEC } else { 2700 }
$outFile = Join-Path $env:TEMP "ccv3-si-out-$date.txt"
$errFile = Join-Path $env:TEMP "ccv3-si-err-$date.txt"
$claudeExit = -1
$recordExit = -1
$claudeTimedOut = $false
$bodyError = $null

# Steps 3-4 run inside a try so that ANY abort still falls through to the final
# Write-RunRow below (the 07-22 class: an error under EAP='Stop' skipped the emit).
try {
  Log "Invoking headless claude -p (allowlisted toolset, timeout=${claudeTimeoutSec}s)"
  # Pin the model (Opus 5.5 eval, P34): unpinned, this ran on whatever the interactive session
  # model was (Opus, then Fable) and competed with Dave's quota; 8 of ~28 runs produced nothing.
  $headlessModel = if ($env:CCV3_HEADLESS_MODEL) { $env:CCV3_HEADLESS_MODEL } else { 'sonnet' }
  $proc = Start-Process -FilePath (Join-Path $env:USERPROFILE '.local\bin\claude.exe') `
    -ArgumentList '-p', '--model', $headlessModel, '--allowedTools', 'Read,Grep,Glob,Write,Bash,WebSearch,WebFetch,Task,Skill' `
    -RedirectStandardInput $promptFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
    -NoNewWindow -PassThru
  # Touch .Handle so .ExitCode stays readable after exit (long-standing PS quirk:
  # without caching the handle, ExitCode can come back $null on a -PassThru process).
  $null = $proc.Handle
  if (-not $proc.WaitForExit($claudeTimeoutSec * 1000)) {
    $claudeTimedOut = $true
    Log "TIMEOUT: claude -p exceeded ${claudeTimeoutSec}s -- killing the process TREE so the registry emit below still runs"
    # taskkill /T (tree), NOT Stop-Process: Stop-Process kills ONLY the named process,
    # so claude's ~9 hook `node` children would orphan permanently -- the exact leak
    # that stranded 29 processes via sweep.mjs's spawnSync timeout (found 2026-07-25).
    try { & taskkill.exe /T /F /PID $proc.Id 2>&1 | Out-Null } catch { }
    # Fallback: if taskkill is unavailable, at least kill the direct child.
    try { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } catch { }
    try { $proc.WaitForExit(15000) | Out-Null } catch { }
  } else {
    $claudeExit = $proc.ExitCode
  }
  foreach ($f in @($outFile, $errFile)) {
    if (Test-Path $f) { Get-Content $f -ErrorAction SilentlyContinue | Tee-Log | Out-Null }
  }
  Log "claude -p exited (code=$claudeExit, timedOut=$claudeTimedOut)"

  # 4) Record the INDEX row deterministically (non-fatal if the proposal is missing).
  # LOCAL EAP drop (2026-08-04): under this script's EAP='Stop', record-index's stderr
  # (e.g. its designed exit-2 "proposal not found" message) merged via 2>&1 raised a
  # NativeCommandError, the catch below set bodyError, and the run was mislabeled
  # Failed -- the designed 'Warn: no proposal' status was unreachable. Same local
  # save/lower/restore pattern as Write-RunRow (emit-run.mjs caller contract #4).
  $prevRecEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & node (Join-Path $si 'record-index.mjs') $date $c.id 2>&1 | ForEach-Object { "$_" } | Tee-Log
    $recordExit = $LASTEXITCODE
    # 5) Deterministic PENDING-DIGEST queue append -- the parent-process push promised
    # by the scope-guard comment at the top of this file. The headless session's own
    # fallback append was permission-denied on 5 of its last 7 runs (Edit deliberately
    # ungranted), so 8 completed runs landed in NO queue. The helper is idempotent
    # (skips if the session already wrote the block) and non-fatal here.
    & node (Join-Path $si 'append-digest.mjs') $date $c.id 2>&1 | ForEach-Object { "$_" } | Tee-Log
    Log "append-digest exit=$LASTEXITCODE (non-fatal)"
  } finally {
    $ErrorActionPreference = $prevRecEAP
  }
} catch {
  $bodyError = "$_"
  Log "RUN BODY THREW (captured; the registry row below records this as Failed): $_"
}

$proposal = "docs/self-improvement/proposals/$date-$($c.id).md"

# --- Report Runs registry: FINAL emit (updates the pre-emit row in place) --------
# Same $runStamp as the pessimistic pre-emit above => same runId => upsert UPDATES
# that row rather than adding a second one. Status is synthesized DETERMINISTICALLY
# and pessimistically: a thrown body or a timed-out/non-zero claude -p is Failed
# (previously these produced NO row at all); a clean run with no proposal is Warn;
# only a clean run that actually recorded a proposal is OK. Non-fatal by contract —
# Write-RunRow swallows its own errors and this block never changes the exit
# semantics below. ntn authenticates via the OS keychain through its ABSOLUTE exe
# (NTN_EXE in lib/notion.mjs); the NOTION_* env scrub above does NOT touch keychain
# creds, so make-run + upsert still authenticate here in the parent process.
if ($bodyError) {
  $siStatus = 'Failed'; $verdict = "run aborted before completing: $bodyError"
} elseif ($claudeTimedOut) {
  $siStatus = 'Failed'; $verdict = "claude -p exceeded the ${claudeTimeoutSec}s timeout and was killed; no proposal produced"
} elseif ($claudeExit -ne 0) {
  $siStatus = 'Failed'; $verdict = "claude -p failed (exit=$claudeExit); see .claude/logs/self-improvement/$date.log"
} elseif (Test-Path $proposal) {
  $siStatus = 'OK'; $verdict = "proposal recorded ($proposal)"
} else {
  $siStatus = 'Warn'; $verdict = "no proposal (claude -p exit=$claudeExit, record-index exit=$recordExit); see docs/self-improvement/INDEX.md"
}
Write-RunRow $siStatus "$($c.id): $verdict"

# --- Triage cockpit refresh (Part C, 2026-07-24): rebuild + publish the cockpit so the
# hosted copy reflects today's proposal set. Non-fatal; runs in THIS parent process.
# publish.mjs lands a DATED immutable folder + latest/ alias on the decks Pages site
# (unlisted, no card) and deliberately never touches the registry artifactUrl (which
# stays on the Notion child page above — premortem findings #1/#2).
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $node = if (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { 'node' }
  & $node (Join-Path $si 'triage\publish.mjs') 2>&1 | ForEach-Object { "$_" } | Tee-Log
  Log "triage cockpit publish exit=$LASTEXITCODE (non-fatal)"
} catch {
  Log "triage cockpit publish threw (non-fatal): $_"
} finally {
  $ErrorActionPreference = $prevEAP
}

# Exit semantics mirror the registry Status synthesized above, so the task's
# LastTaskResult and the registry row can never disagree about whether the run
# worked. A body throw / timeout / claude failure now exits NON-ZERO (it used to
# ride out on $recordExit and could report success for a run that never produced
# anything) — the always-emit row makes the same outcome visible in Notion.
if ($bodyError -or $claudeTimedOut -or $claudeExit -ne 0) {
  Log "FAILED: $verdict"
  exit 1
} elseif ($recordExit -eq 0) {
  Log "Done. Proposal: $proposal"
  exit 0
} else {
  Log "WARN: proposal not recorded (record-index exit=$recordExit). Check the log + $proposal."
  exit $recordExit
}
