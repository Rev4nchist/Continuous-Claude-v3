@echo off
REM Weekly CCv3 health check
REM Registered in Windows Task Scheduler as "CCv3-Health-Check"
REM Runs every Friday at 08:03am (local time)
REM Output files land in C:\Users\david.hayes\continuous-claude\.claude\cache\health-checks\
REM Run manually: schtasks /run /tn "CCv3-Health-Check"

REM --- Shared vars resolved FIRST (2026-08-04): the pessimistic pre-emit below must
REM fire BEFORE the long python run, so everything it needs is computed up front.
REM Set lines stay OUTSIDE parenthesized blocks -- batch parse-time-expands every
REM %VAR% when it parses a whole block, so a `set` inside one would be too late.
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
set "REGISTRY=C:\Users\david.hayes\continuous-claude\scripts\report-registry"

REM Dated-log capture (since 2026-07-16): keep full stdout+stderr so a no-op is
REM diagnosable. Resolve the date via powershell (System32, always on the Task
REM Scheduler minimal PATH); fall back to last-run.log.
set "NLOG_DIR=C:\Users\david.hayes\.claude\logs\health-check"
if not exist "%NLOG_DIR%" mkdir "%NLOG_DIR%"
set "NLOG_DATE="
for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"`) do set "NLOG_DATE=%%d"
if defined NLOG_DATE (set "NLOG=%NLOG_DIR%\%NLOG_DATE%.log") else (set "NLOG=%NLOG_DIR%\last-run.log")

REM period + runDate. BOTH emits below pass the SAME --runDate: runId is
REM `<type>|<period>|<runDate>` and upsert queries by Run ID, so the final emit
REM UPDATES the pessimistic row in place instead of appending a second one
REM (emit-run.mjs caller contract #6). Vars are pre-cleared: a failed powershell
REM date call must not leave a previous value in scope.
set "TODAY="
for /f %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "TODAY=%%D"
set "RUN_STAMP="
for /f "usebackq delims=" %%s in (`powershell -NoProfile -Command "(Get-Date).ToUniversalTime().ToString('o')"`) do set "RUN_STAMP=%%s"

REM CLAUDE_OPC_DIR: the Task Scheduler minimal env lacks it, which made the
REM claude-opc-dir-set check a chronic MEDIUM warn in every scheduled run.
set "CLAUDE_OPC_DIR=C:\Users\david.hayes\continuous-claude\opc"

REM --- PESSIMISTIC PRE-EMIT (always-emit contract, migrated to emit-run.mjs) ---
REM Survives a hard kill during the python run: a killed run now leaves an
REM attributed Failed row instead of a silent watchdog miss. --no-refresh: the
REM pessimistic row must NOT publish to live surfaces (only the final emit
REM refreshes). --out is a DISTINCT path so this file cannot masquerade as the
REM final emit (contract #5). NON-FATAL by caller contract #3: exit code logged,
REM never propagated.
set "PRE_EMIT=%TEMP%\report-run-Health-Check-preemit.json"
del "%PRE_EMIT%" 2>nul
if defined TODAY if defined RUN_STAMP "%NODE%" "%REGISTRY%\emit-run.mjs" --type "System Health" --source "Health-Check" --period "%TODAY%" --runDate "%RUN_STAMP%" --status Failed --no-refresh --out "%PRE_EMIT%" --summary "in-progress - health check started at %RUN_STAMP%. Updated in place on completion; if it still reads Failed the run was killed or aborted before finishing (see %NLOG%)." >> "%NLOG%" 2>&1
if defined TODAY if defined RUN_STAMP if errorlevel 1 echo [%date% %time%] pre-emit FAILED ^(non-fatal -- see %NLOG%^)
if defined TODAY if defined RUN_STAMP if not errorlevel 1 echo [%date% %time%] pre-emit registry row landed ^(non-fatal^)
if not defined RUN_STAMP echo [%date% %time%] RUN_STAMP empty -- pre-emit skipped ^(non-fatal^)

REM Second pessimistic pre-emit for the Weekend Plan row (same runDate, its own
REM type -> its own runId). weekend-plan.mjs updates it in place at the end of the
REM chain; if the chain dies first, this row truthfully reads Failed.
set "WP_PRE_EMIT=%TEMP%\report-run-Weekend-Plan-preemit.json"
del "%WP_PRE_EMIT%" 2>nul
if defined TODAY if defined RUN_STAMP "%NODE%" "%REGISTRY%\emit-run.mjs" --type "Weekend Plan" --source "Health-Check" --period "%TODAY%" --runDate "%RUN_STAMP%" --status Failed --no-refresh --out "%WP_PRE_EMIT%" --summary "in-progress - health-check chain started at %RUN_STAMP%. Updated in place when weekend-plan.mjs completes; if it still reads Failed the chain died first (see %NLOG%)." >> "%NLOG%" 2>&1
if defined TODAY if defined RUN_STAMP if errorlevel 1 echo [%date% %time%] Weekend Plan pre-emit FAILED ^(non-fatal -- see %NLOG%^)

cd /d C:\Users\david.hayes\continuous-claude\opc
set PYTHONPATH=.

echo [%date% %time%] Starting CCv3 weekly health check...

REM --skip-slow --quiet is the documented scheduled form: the full run's slow checks + the
REM trailing claude -p step blew the 15-min ExecutionTimeLimit, so the scheduler killed the task
REM (0x41306 SCHED_S_TASK_TERMINATED). Skipping the slow checks keeps the run well inside budget.
call uv run python scripts\health_check.py --skip-slow --quiet
set EXIT_CODE=%ERRORLEVEL%

echo [%date% %time%] Health check finished. exit=%EXIT_CODE%

REM --- Notion dashboard mirror (deterministic; Stream C, approved proposal 04) ---
REM After the Python run, mirror the newest health_*.json onto the CCv3 Weekly Health
REM Checks Notion page via scripts/report-registry/health-mirror.mjs -- ntn-only, NO MCP,
REM NO claude -p. This REPLACES the old claude -p + scripts/notion-health-prompt.md step
REM (that prompt is now DEPRECATED, kept on disk for reference). NON-FATAL: a mirror
REM failure NEVER alters %EXIT_CODE% (the python exit captured above); the mjs exits 0
REM on success/partial by contract. APPEND (>>) since 2026-08-04: a single `>` here
REM truncated the pre-emit's log lines written above.
cd /d C:\Users\david.hayes\continuous-claude
set "HEALTH_MIRROR=%REGISTRY%\health-mirror.mjs"

REM Linear (no parenthesized block) so %ERRORLEVEL% expands at EXECUTE time --
REM MIRROR_EXIT feeds weekend-plan.mjs's chain-status synthesis below. -1 = the
REM mirror never ran (missing file), which correctly reads as a partial chain.
set "MIRROR_EXIT=-1"
if not exist "%HEALTH_MIRROR%" echo [%date% %time%] WARN: %HEALTH_MIRROR% not found -- skipping Notion mirror.
if exist "%HEALTH_MIRROR%" echo [%date% %time%] Mirroring results to Notion dashboard... log=%NLOG%
if exist "%HEALTH_MIRROR%" "%NODE%" "%HEALTH_MIRROR%" >> "%NLOG%" 2>&1
if exist "%HEALTH_MIRROR%" set "MIRROR_EXIT=%ERRORLEVEL%"
REM The captured log's final line (health-mirror: OK/PARTIAL/STALE ...) is the real outcome.
if exist "%HEALTH_MIRROR%" echo [%date% %time%] Notion mirror step finished exit=%MIRROR_EXIT% ^(non-fatal^). log=%NLOG%

REM --- Weekend Fix Plan + FINAL registry emits (2026-08-04, Dave's redesign) ---
REM weekend-plan.mjs is the chain's closer: it reads the fresh health JSON
REM (freshness-guarded), merges findings with integration-ready Self-Improvement
REM research into the Weekend Fix Plan page, then final-emits BOTH registry rows
REM in place (same --runDate as the pre-emits above) under the NEW OK semantics:
REM Status measures the PIPELINE (check ran + mirror landed + plan generated);
REM the WARN/FAIL findings are the payload, carried in the summary string. If
REM this step crashes, both pessimistic Failed rows stand -- "chain died", which
REM is exactly what they should say. NON-FATAL: never changes %EXIT_CODE%.
echo [%date% %time%] Generating Weekend Fix Plan + final registry emits... log=%NLOG%
"%NODE%" "%REGISTRY%\weekend-plan.mjs" --period "%TODAY%" --runDate "%RUN_STAMP%" --health-exit %EXIT_CODE% --mirror-exit %MIRROR_EXIT% >> "%NLOG%" 2>&1
if errorlevel 1 echo [%date% %time%] weekend-plan reported PARTIAL/failure ^(non-fatal -- see %NLOG%^)
if not errorlevel 1 echo [%date% %time%] Weekend Fix Plan generated + registry rows updated ^(non-fatal^).

REM --- Report Runs drift check (T4.2 wired to schedule, T6.1 #7) ---
REM FINAL non-fatal step: run the freshness/drift detector so a report type that silently
REM stopped landing rows gets flagged here (it exits nonzero when any type is stale). This
REM must NEVER change %EXIT_CODE% -- that is captured above and untouched; the final
REM exit /b uses it regardless of what check-drift returns. Output captured to the dated
REM log since 2026-08-04 (it previously went to the discarded scheduler console).
echo [%date% %time%] Running report-registry drift check... log=%NLOG%
"%NODE%" "%REGISTRY%\check-drift.mjs" >> "%NLOG%" 2>&1
echo [%date% %time%] Drift check finished exit=%ERRORLEVEL% (non-fatal).

REM Exit code contract:
REM   0 = all pass
REM   1 = warnings only
REM   2 = HIGH severity failure
REM   3 = CRITICAL severity failure
REM The next Claude Code session will find the JSON/MD reports in .claude/cache/health-checks/
REM and the memory-awareness hook will surface any stored learnings from the run.

exit /b %EXIT_CODE%
