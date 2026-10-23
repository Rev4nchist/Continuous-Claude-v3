# CCv3 Project Cards daily sweep -- Windows Task Scheduler entry point.
# Refreshes every FourthOS project card (zero-LLM deterministic assemble) and, for any
# card that changed or is unpublished, republishes its interactive embed; then refreshes
# the Reporting Hub gallery table. The one non-deterministic step (bind HTML upload to a
# Notion embed) runs via headless `claude -p` + the claude.ai Notion connector.
#
# Manual run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\project-cards\run-sweep.ps1
# Any extra args (e.g. --target mobile-cockpit) pass straight through to sweep.mjs.
$ErrorActionPreference = 'Stop'

$repo = (Join-Path $env:USERPROFILE 'continuous-claude')
Set-Location $repo

# The Notion connector is DISABLED whenever ANTHROPIC_API_KEY is set (it takes precedence
# over the claude.ai subscription login). Unset it so `claude -p` loads the connector.
# sweep.mjs also strips it for each spawned claude; unsetting here matches the CCv3
# scheduled-task convention and keeps the whole process tree clean. Harmless if unset.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

$date   = Get-Date -Format 'yyyy-MM-dd'
$logDir = Join-Path $repo '.claude\logs\project-cards'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "$date.log"

# UTF-8 logging, Windows-PowerShell-5.1-COMPATIBLE (root-caused 2026-07-17):
# `Tee-Object -Encoding` is PowerShell 6+ ONLY. The scheduled task runs
# powershell.exe (5.1), where that parameter binding fails -- and under
# $ErrorActionPreference='Stop' the wrapper died on its FIRST log line (exit 1,
# no log, no sweep: the 7/16 17:45 and 7/17 07:45 runs). Probe evidence:
# 5.1 -> "A parameter cannot be found that matches parameter name 'Encoding'".
# Tee-Log uses Out-File -Encoding utf8 (exists in 5.1; BOM there, BOM-less on 7,
# both readable by grep/Node) and works under BOTH engines. Never reintroduce
# `Tee-Object -Encoding` in a wrapper that powershell.exe runs.
function Tee-Log {
  param([Parameter(ValueFromPipeline=$true)]$Line)
  process { $Line | Out-File -FilePath $log -Append -Encoding utf8; $Line }
}
"[$(Get-Date -Format o)] CCv3-Project-Cards sweep starting" | Tee-Log

# T3.1: the sweep emits a Project Portfolio report-run.json to $TEMP for the
# registry spine. Remove any stale emit from a prior run FIRST so the final
# upsert step below only fires when THIS run actually emitted (a --dry-run or a
# mobile-cockpit/triage sub-target emits nothing -- the file stays absent and the
# upsert is skipped, never re-upserting a stale record).
$emitFile = Join-Path $env:TEMP 'report-run-Project-Cards.json'
Remove-Item $emitFile -ErrorAction SilentlyContinue

# --- ALWAYS-EMIT registry contract (root-caused 2026-07-25) ----------------------
# THE BUG THIS FIXES: sweep.mjs emits its report-run.json at the END, and this
# wrapper upserts it afterwards -- so a sweep KILLED mid-run emits nothing and the
# period gets ZERO rows. The watchdog then reports a silent miss, indistinguishable
# from a run that never launched. That is the 2026-07-21 miss exactly: the log
# truncates mid-sweep because the task's then-PT30M ExecutionTimeLimit killed it
# (raised to PT1H on 2026-07-25).
#
# FIX: emit a PESSIMISTIC row BEFORE the sweep, then re-stamp the sweep's OWN emit
# with the same runDate so the final upsert UPDATES that row instead of adding a
# second one (make-run derives runId = "<type>|<period>|<runDate>", and upsert
# queries by Run ID). A killed sweep therefore leaves a visible, self-explaining
# Failed row carrying this run's stamp.
#
# Only a FULL sweep is pre-emitted: a --dry-run or a --target sub-run legitimately
# emits nothing, and a pre-emit there would leave a permanent bogus Failed row for
# the day. This mirrors the existing $emitFile gate on the upsert below.
$runStamp = (Get-Date).ToUniversalTime().ToString('o')
$node = if (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { 'node' }
$isFullSweep = -not ($args | Where-Object { $_ -eq '--dry-run' -or $_ -eq '--target' })
# Distinct from $emitFile ON PURPOSE -- see the --out note in the pre-emit below.
# Cleared up front so a previous run's pre-emit can never be mistaken for this one's.
$preEmitFile = Join-Path $env:TEMP 'report-run-Project-Cards-preemit.json'
Remove-Item $preEmitFile -ErrorAction SilentlyContinue

if ($isFullSweep) {
  # Saved/restored LOCALLY (not the global flip at :138, below): this block
  # still runs before that flip, so the script's EAP is 'Stop' on entry here.
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    # T9.3: migrated to emit-run.mjs (make-run + upsert in ONE node process --
    # see its header comment for the full caller contract). The OLD shape here
    # was TWO chained native commands (make-run, then a SEPARATE
    # `upsert.mjs ... 2>&1 | ForEach-Object`), run entirely under the script's
    # global EAP='Stop' (the flip to 'Continue' at :138 is BELOW this block) --
    # upsert's first stderr line was promoted to a TERMINATING
    # NativeCommandError, caught by this block's own try/catch and logged
    # "non-fatal" -- daily, unread, on 16 of 16 runs since this shipped
    # 2026-07-25. With make-run+upsert in one process there is at most ONE
    # native command left to guard here instead of two.
    #
    # IMPORTANT -- empirically corrects emit-run.mjs's own header comment
    # (contract #4, "redirect to a FILE"): on THIS machine's powershell.exe 5.1
    # (5.1.26100.8875), file redirection ALONE does NOT avoid the throw. Under
    # EAP='Stop', a probe harness (see T9.3 verification) showed `*>>`, `*>`,
    # `2>`, `2>$null`, and even a bare `2>&1` assignment to a variable ALL threw
    # NativeCommandError for the same benign stderr line -- with NO
    # ForEach-Object anywhere in the pipeline. The one thing that reliably
    # avoided it was dropping $ErrorActionPreference to 'Continue' LOCALLY
    # around the call -- exactly what run-research.ps1's Write-RunRow already
    # does (the "ONLY copy that got it right", per emit-run.mjs's own header),
    # and exactly what this file's OWN :134-143 comment already explains for
    # the FINAL emit below. Restored in the `finally` below so the block's
    # scope doesn't leak EAP='Continue' past this if-block (the sweep.mjs
    # invocation further down still does its own explicit global flip).
    #
    # --out is MANDATORY (contract #5): the default path is byte-for-byte
    # $emitFile, the file the post-sweep step below reads to decide "did the
    # sweep emit?". Without --out the pre-emit would masquerade as a sweep
    # emit. (Found on the first live run, 2026-07-25 17:45.)
    # --runDate is the SAME $runStamp as the final emit (contract #6), so the
    # two share a runId and the final upsert UPDATES this row in place instead
    # of appending a second one.
    # --no-refresh: only the FINAL emit (below) refreshes the report child
    # pages -- same scope as the pre-emit step this replaces.
    # Keep this summary pure ASCII: this file has no BOM, so powershell.exe 5.1
    # decodes it as CP1252 and a UTF-8 em-dash inside a DOUBLE-QUOTED string
    # becomes a smart quote that terminates the string early (comments unaffected).
    & $node (Join-Path $repo 'scripts\report-registry\emit-run.mjs') `
      --type 'Project Portfolio' --source 'Project-Cards' --period $date --runDate $runStamp `
      --status 'Failed' --artifactUrl 'https://www.notion.so/38f76fd7ac8280478e50dd2956ba6e8a' `
      --out $preEmitFile --no-refresh `
      --summary "in-progress - sweep started at $runStamp. Updated in place on completion; if it still reads Failed the sweep was killed or aborted before finishing (see .claude/logs/project-cards/$date.log)." `
      2>&1 | ForEach-Object { "$_" } | Tee-Log
    # emit-run.mjs is HONEST about failure by design (contract #3: exit 0 = the
    # row landed, exit 1 = it did not) -- this wrapper logs the exit code and
    # ignores it, same non-fatal contract as every other registry step here.
    "[$(Get-Date -Format o)] pre-emit registry step (emit-run.mjs) exit=$LASTEXITCODE (non-fatal)" | Tee-Log
  } catch {
    "[$(Get-Date -Format o)] pre-emit registry step threw (non-fatal): $_" | Tee-Log
  } finally {
    $ErrorActionPreference = $prevEAP
  }
}

# sweep.mjs logs progress to stderr and spawns claude/ntn that also write stderr. Under
# ErrorActionPreference='Stop', a native command's stderr (via 2>&1) is raised as a
# terminating NativeCommandError and would abort the wrapper on benign log output. Gate
# success on the process exit code instead, so real failures still surface (code != 0).
$ErrorActionPreference = 'Continue'
# 2>&1 also wraps each stderr line as an ErrorRecord; Tee/host then renders it with error
# formatting (red "NativeCommandError" + CategoryInfo block) even under 'Continue', making
# benign progress logs look like failures. Stringify each record ("$_") before Tee so it
# lands as a plain log line. $LASTEXITCODE still reflects node's exit code (cmdlets don't
# reset it), so exit-code gating below is unaffected.
& node (Join-Path $repo 'scripts\project-cards\sweep.mjs') @args 2>&1 |
    ForEach-Object { "$_" } | Tee-Log
$code = $LASTEXITCODE
"[$(Get-Date -Format o)] sweep exited (code=$code)" | Tee-Log

# T3.1 FINAL step: upsert the emitted report-run.json into the Report Runs
# registry. NON-FATAL by contract -- the registry is observability, not the
# sweep's product, so a registry outage must NEVER change the sweep's exit code.
# Only runs when the sweep actually emitted the file (full real sweep); wrapped in
# try/catch and never touches $code.
# $node was resolved above (T6.1 #8: Task Scheduler's minimal PATH omits node).
if (Test-Path $emitFile) {
    # Re-stamp the sweep's own emit onto THIS run's $runStamp so its upsert UPDATES
    # the pessimistic pre-emit row rather than creating a second row for the period.
    # runId must be rebuilt from the re-stamped runDate to stay consistent with
    # make-run's "<type>|<period>|<runDate>" derivation. Non-fatal: if the re-stamp
    # fails, the sweep's original emit still upserts (two rows for the day is worse
    # bookkeeping but never data loss), so this must not abort the upsert.
    if ($isFullSweep) {
        try {
            & $node -e "const fs=require('fs');const p=process.argv[1];const s=process.argv[2];const r=JSON.parse(fs.readFileSync(p,'utf8'));r.runDate=s;r.runId=r.type+'|'+r.period+'|'+s;fs.writeFileSync(p,JSON.stringify(r,null,2)+'\n');console.log('re-stamped '+r.runId);" $emitFile $runStamp 2>&1 |
                ForEach-Object { "$_" } | Tee-Log
        } catch {
            "[$(Get-Date -Format o)] emit re-stamp threw (non-fatal, upserting original): $_" | Tee-Log
        }
    }
    try {
        & $node (Join-Path $repo 'scripts\report-registry\upsert.mjs') $emitFile 2>&1 |
            ForEach-Object { "$_" } | Tee-Log
        "[$(Get-Date -Format o)] report-run upsert exit=$LASTEXITCODE (non-fatal)" | Tee-Log
    } catch {
        "[$(Get-Date -Format o)] report-run upsert threw (non-fatal): $_" | Tee-Log
    }

    # T7.1 FINAL step: refresh the 6 report child pages' "Current run" callouts +
    # the Reports hub launcher from the newest registry row per type. Deterministic
    # (ntn-only, NO MCP), READ-then-splice -- never touches the human hub narrative
    # or the History linked views. NON-FATAL by the same contract as the upsert: the
    # page refresh is observability, not the sweep's product, so it must NEVER change
    # $code. Runs only on a full real sweep (gated by $emitFile, same as the upsert)
    # and AFTER the upsert, so it reflects this run's just-upserted Project Portfolio
    # row. Wrapped in try/catch; never touches $code.
    try {
        & $node (Join-Path $repo 'scripts\report-registry\refresh-pages.mjs') 2>&1 |
            ForEach-Object { "$_" } | Tee-Log
        "[$(Get-Date -Format o)] report-page refresh exit=$LASTEXITCODE (non-fatal)" | Tee-Log
    } catch {
        "[$(Get-Date -Format o)] report-page refresh threw (non-fatal): $_" | Tee-Log
    }
} elseif ($isFullSweep) {
    # A FULL sweep that emitted nothing means it failed before its own emit step.
    # The pessimistic pre-emit row above is now the period's record and correctly
    # reads Failed -- do NOT overwrite or clear it, and skip the page refresh (there
    # is no new genuine row to publish).
    "[$(Get-Date -Format o)] full sweep emitted no report-run.json (sweep exit=$code) -- pre-emit Failed row stands as this period's record; skipping page refresh" | Tee-Log
} else {
    "[$(Get-Date -Format o)] no report-run.json emitted (dry-run or sub-target) -- skipping registry upsert + page refresh" | Tee-Log
}

exit $code
