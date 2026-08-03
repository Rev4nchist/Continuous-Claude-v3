@echo off
REM Weekly FourthOS sponsor update package (Carly & Christian)
REM Registered in Windows Task Scheduler as "CCv3-FourthOS-Weekly"
REM Runs every Thursday at 07:00am (local time)
REM Stages an UNLISTED preview to the ai-enablement-decks GitHub Pages site and pings Dave.
REM It deliberately does NOT promote to the live sponsor URL -- that is Dave's approval step:
REM     node scripts\fourthos-weekly\promote.mjs
REM Run manually: schtasks /run /tn "CCv3-FourthOS-Weekly"

cd /d C:\Users\david.hayes\continuous-claude
set GEN_PROMPT=scripts\fourthos-weekly\generate-prompt.md

echo [%date% %time%] Starting FourthOS weekly sponsor update generation...

if not exist %GEN_PROMPT% (
    echo [%date% %time%] FAIL: %GEN_PROMPT% not found -- aborting.
    exit /b 1
)

REM Resolve an ABSOLUTE node path (needed by the verify + registry steps). A cmd
REM .bat inherits a minimal PATH under Task Scheduler and bare `node` may not
REM resolve (same class of failure that lost 4 months to bare `python`). Fall
REM back to bare `node` only if the standard path is absent.
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

REM Today's date (YYYY-MM-DD), resolved BEFORE the claude run so the log file is
REM dated. Use powershell (always on the System32 PATH) rather than %date%
REM (locale-formatted) or node-in-`for /f` (the quoted spaced node path breaks
REM cmd's for/f parsing). If the date can't be resolved we still run claude
REM (logging to last-run.log) but skip the registry upsert later.
set "RUN_DATE="
for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"`) do set "RUN_DATE=%%d"

REM Log capture: every headless claude -p run writes its full stdout+stderr to a
REM dated log so a silent no-op is diagnosable after the fact (a same-day manual
REM rerun overwrites that day's log -- accepted).
set "LOG_DIR=C:\Users\david.hayes\.claude\logs\fourthos-weekly"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
if defined RUN_DATE (set "LOG_NAME=%RUN_DATE%.log") else (set "LOG_NAME=last-run.log")
set "LOG_FILE=%LOG_DIR%\%LOG_NAME%"
echo [%date% %time%] claude -p output will be captured to %LOG_FILE%

REM --- ALWAYS-EMIT pre-emit (S5a, 2026-08-02) -------------------------------
REM THE BUG THIS CLOSES: the registry emit lives at the END of this wrapper
REM (line ~135). Any path that returns before it -- claude -p killed mid-run,
REM the task's ExecutionTimeLimit firing, a reboot -- records ZERO rows for the
REM period, indistinguishable from a run that never launched. Verified
REM 2026-08-02: the FourthOS scheduled run has NEVER produced a registry row
REM under the current emit code (it landed 2026-07-16, after that day's run);
REM every historical row came from promote.mjs or a hand backfill.
REM
REM FIX: emit a pessimistic Failed row BEFORE the long call, stamped with a
REM RUN_STAMP the final emit reuses -- make-run derives
REM runId = "<type>|<period>|<runDate>", and upsert queries by Run ID, so the
REM final emit UPDATES this row instead of appending a second one per period.
REM A killed run therefore leaves a visible, self-explaining Failed row.
REM
REM --out is MANDATORY: make-run's DEFAULT path is byte-identical to %RUN_EMIT%,
REM the file the `if not exist` guard below uses to decide "did the final emit
REM fire?". Without --out the pre-emit masquerades as the final emit and a
REM killed run would upsert as though it had succeeded. That lesson was already
REM paid for in run-sweep.ps1:78-83 on 2026-07-25 -- do not re-learn it here.
REM
REM Pre-cleared before the for/f (the scheduled-health-check.bat:75 trap: a
REM failed powershell date call leaves the PREVIOUS value in scope).
set "RUN_STAMP="
for /f "usebackq delims=" %%s in (`powershell -NoProfile -Command "(Get-Date).ToUniversalTime().ToString('o')"`) do set "RUN_STAMP=%%s"
set "RUNDATE_ARG="
if defined RUN_STAMP set "RUNDATE_ARG=--runDate %RUN_STAMP%"
set "PRE_EMIT=%TEMP%\report-run-FourthOS-Weekly-preemit.json"
del "%PRE_EMIT%" 2>nul
if defined RUN_DATE if defined RUN_STAMP "%NODE_EXE%" scripts\report-registry\make-run.mjs --type "FourthOS Sponsor" --source "FourthOS-Weekly" --period %RUN_DATE% %RUNDATE_ARG% --status Failed --out "%PRE_EMIT%" --summary "in-progress - generation started at %RUN_STAMP%. Updated in place on completion; if it still reads Failed the run was killed or aborted before finishing (see %LOG_NAME%)."
REM Three corrections, 2026-08-03, all found by an independent eval of the change
REM that introduced this block the day before. Each is the same species of defect
REM this block exists to fix -- a step that cannot report its own failure.
REM
REM (1) --no-refresh. Without it upsert.mjs defaults refresh ON (upsert.mjs:273)
REM     and spawns refresh-pages.mjs, which rewrites the WHOLE 6-type hub table --
REM     publishing this pessimistic Status=Failed row to the LIVE Notion hub
REM     before generation has even started, through a blocking 240s spawn sitting
REM     inside the pre-emit window. run-sweep.ps1:120 already passed --no-refresh
REM     for exactly this reason; the two pre-emits shipped in one effort disagreed
REM     until today. ONLY the final emit below refreshes surfaces.
REM (2) Its own log. %LOG_FILE% is opened at :95 with a SINGLE `>` (truncate) for
REM     the claude -p capture, so this upsert's output -- the only evidence it ran
REM     at all -- was erased moments later by the very next command. A distinct
REM     file is used rather than switching :95 to `>>`, because the documented
REM     "a same-day manual rerun overwrites that day's log" behaviour at :35-37 is
REM     deliberate and worth keeping.
REM (3) Gate the success echo on the EXIT CODE, not on the emit file existing.
REM     %PRE_EMIT% is written by make-run ABOVE, so the old form printed
REM     "upserted" even when the upsert had failed. `if errorlevel 1` is used
REM     rather than %ERRORLEVEL% deliberately: this must not sit inside a
REM     parenthesized block, where cmd expands %ERRORLEVEL% at PARSE time (the
REM     same class as the scheduled-health-check.bat:75 trap).
set "PRE_LOG=%LOG_FILE%.pre-emit.txt"
del "%PRE_LOG%" 2>nul
if exist "%PRE_EMIT%" "%NODE_EXE%" scripts\report-registry\upsert.mjs "%PRE_EMIT%" --no-refresh >> "%PRE_LOG%" 2>&1
if exist "%PRE_EMIT%" if errorlevel 1 echo [%date% %time%] pre-emit registry upsert FAILED ^(non-fatal -- see %PRE_LOG%^)
if exist "%PRE_EMIT%" if not errorlevel 1 echo [%date% %time%] pre-emit registry row upserted ^(non-fatal^)
if not exist "%PRE_EMIT%" echo [%date% %time%] pre-emit make-run emitted nothing -- continuing ^(non-fatal^)

REM Feed the generate prompt to a non-interactive claude -p session. The prompt instructs
REM Claude Code to read the FourthOS Notion cockpit, refresh the Tier-3 Update Package page,
REM render the Tier-1 dashboard + Tier-2 deep-dive, stage them to fourthos/preview/ (unlisted),
REM and notify Dave via Slack + a Notion comment. Fail-loud guards live inside the prompt.
REM claude -p must auth via the claude.ai subscription login, not a stale ANTHROPIC_API_KEY in env.
set "ANTHROPIC_API_KEY="
REM Headless claude -p AUTO-DENIES any MCP tool not explicitly granted (root-caused
REM 2026-07-16: this, not connector unavailability, caused the silent SKIP no-ops).
REM Grant exactly the Notion + Slack tools the generate prompt needs -- nothing more.
set "GEN_TOOLS=mcp__claude_ai_Notion__notion-fetch,mcp__claude_ai_Notion__notion-search,mcp__claude_ai_Notion__notion-query-data-sources,mcp__claude_ai_Notion__notion-create-pages,mcp__claude_ai_Notion__notion-update-page,mcp__claude_ai_Notion__notion-create-comment,mcp__claude_ai_Slack__slack_send_message"
REM --add-dir grants the decks repo as an ADDITIONAL workspace root (S9,
REM 2026-08-02). The 2026-07-30 log concluded "a real generate would have failed
REM at the staging step" -- that conclusion is REFUTED: four bounded probes
REM showed Bash `git -C <decks>`, Read and Write outside the workspace all work
REM under this exact grant. The real cause was narrower -- a NON-GRANTED tool
REM (PowerShell, absent from --allowedTools) used outside the workspace, which
REM headless auto-denies. --add-dir removes the workspace half of that class.
type %GEN_PROMPT% | call claude -p --output-format text --add-dir "C:\Users\david.hayes\Projects\ai-enablement-decks" --allowedTools "%GEN_TOOLS%,Bash,Read,Write,Edit,Glob,Grep" > "%LOG_FILE%" 2>&1
set EXIT_CODE=%ERRORLEVEL%

echo [%date% %time%] FourthOS weekly generation finished. exit=%EXIT_CODE% log=%LOG_FILE%

REM Outcome contract (since 2026-07-16):
REM   The claude -p exit code alone CANNOT distinguish OK from SKIP or a silent
REM   no-op (all exit 0). verify-run.mjs classifies the outcome deterministically
REM   from ARTIFACT TRUTH (fresh committed fourthos/preview/ in the decks repo,
REM   absence of _ERROR.md) plus the log sentinel line: OK / Warn / Skipped / Failed.
REM   The registry row records that status; this wrapper exits 1 only on Failed
REM   (OK/Warn/Skipped exit 0 -- Skipped is expected and distinctly recorded, so a
REM   red Task Scheduler light for it would be noise).
REM   The stable live sponsor deck is never overwritten by this task; promotion is manual.

REM --- Deterministic outcome classification ---------------------------------
REM verify-run.mjs prints exactly one line `STATUS|reason`. Route it through a
REM temp file (not for/f backquotes -- the quoted spaced node path breaks cmd's
REM for/f command parsing).
set "VERIFY_OUT_FILE=%TEMP%\fourthos-verify-out.txt"
del "%VERIFY_OUT_FILE%" 2>nul
REM verify stderr goes into the dated log so a verify-crashed row stays debuggable
"%NODE_EXE%" scripts\fourthos-weekly\verify-run.mjs --log "%LOG_FILE%" --exit %EXIT_CODE% > "%VERIFY_OUT_FILE%" 2>>"%LOG_FILE%"
set "VERIFY_LINE="
if exist "%VERIFY_OUT_FILE%" for /f "usebackq delims=" %%v in ("%VERIFY_OUT_FILE%") do set "VERIFY_LINE=%%v"

set "RUN_STATUS="
set "RUN_REASON="
if defined VERIFY_LINE for /f "tokens=1* delims=|" %%a in ("%VERIFY_LINE%") do (
    set "RUN_STATUS=%%a"
    set "RUN_REASON=%%b"
)

REM Fail-open: if verify-run.mjs crashed or printed garbage, record Warn --
REM never a silent OK.
if not defined RUN_STATUS (
    set "RUN_STATUS=Warn"
    set "RUN_REASON=verify-crashed"
)
if not defined RUN_REASON set "RUN_REASON=unspecified"
if not "%RUN_STATUS%"=="OK" if not "%RUN_STATUS%"=="Warn" if not "%RUN_STATUS%"=="Skipped" if not "%RUN_STATUS%"=="Failed" (
    set "RUN_STATUS=Warn"
    set "RUN_REASON=verify-bad-output"
)
echo [%date% %time%] verified outcome: %RUN_STATUS% ^(%RUN_REASON%^)

REM --- Report Runs registry (T3.3): FINAL non-fatal step. -------------------
REM Observability, not the report's product -- it never changes the exit
REM contract below. GUARD: without RUN_DATE an empty --period would emit a
REM garbage row, so skip the upsert entirely.
if not defined RUN_DATE (
    echo [%date% %time%] could not resolve RUN_DATE -- skipping registry upsert ^(non-fatal^)
    goto :final_exit
)

REM Only advertise the preview URL for a verified-OK run. Pass the flag ONLY
REM in that case: make-run.mjs REJECTS a non-http artifactUrl and exits 1
REM without emitting, so the old `--artifactUrl "none"` on any non-OK status
REM killed the emit and the registry upsert was skipped entirely. Effect: a
REM Warn, Skipped or Failed run recorded NO ROW AT ALL -- the always-emit
REM spine was blind in exactly the cases it exists to record. Omitting the
REM flag is the supported way to say "no artifact" (verified by execution).
set "ARTIFACT_ARG="
if "%RUN_STATUS%"=="OK" set "ARTIFACT_ARG=--artifactUrl https://rev4nchist.github.io/ai-enablement-decks/fourthos/preview/"

set "RUN_EMIT=%TEMP%\report-run-FourthOS-Weekly.json"
del "%RUN_EMIT%" 2>nul
REM %RUNDATE_ARG% carries the SAME RUN_STAMP the pre-emit used, so this emit's
REM runId matches and upsert UPDATES the pessimistic row rather than appending a
REM second row for the period. If RUN_STAMP failed to resolve the arg is empty
REM and make-run falls back to its own timestamp (two rows for the day is worse
REM bookkeeping, never data loss).
"%NODE_EXE%" scripts\report-registry\make-run.mjs --type "FourthOS Sponsor" --source "FourthOS-Weekly" --period %RUN_DATE% %RUNDATE_ARG% --status %RUN_STATUS% %ARTIFACT_ARG% --summary "%RUN_REASON% (exit=%EXIT_CODE%, log=%LOG_NAME%)"
if not exist "%RUN_EMIT%" (
    echo [%date% %time%] no report-run.json emitted -- skipping registry upsert
    goto :final_exit
)
"%NODE_EXE%" scripts\report-registry\upsert.mjs "%RUN_EMIT%"
echo [%date% %time%] report-run upsert done ^(exit=%ERRORLEVEL%, non-fatal^)

:final_exit
REM Failed -> exit 1 (Task Scheduler Last Run Result shows the failure).
REM OK/Warn/Skipped -> exit 0 (the registry row + dated log are the
REM observability surface for those).
if "%RUN_STATUS%"=="Failed" exit /b 1
exit /b 0
