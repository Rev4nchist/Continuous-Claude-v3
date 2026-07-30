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
type %GEN_PROMPT% | call claude -p --output-format text --allowedTools "%GEN_TOOLS%,Bash,Read,Write,Edit,Glob,Grep" > "%LOG_FILE%" 2>&1
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
"%NODE_EXE%" scripts\report-registry\make-run.mjs --type "FourthOS Sponsor" --source "FourthOS-Weekly" --period %RUN_DATE% --status %RUN_STATUS% %ARTIFACT_ARG% --summary "%RUN_REASON% (exit=%EXIT_CODE%, log=%LOG_NAME%)"
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
