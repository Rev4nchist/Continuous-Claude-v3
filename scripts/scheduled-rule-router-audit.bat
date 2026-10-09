@echo off
REM Weekly rule-router precision audit (Task Scheduler: CCv3-RuleRouter-Audit, Mondays 09:07).
REM Writes docs\self-improvement\audits\rule-router-<date>.md from ~/.claude/logs/rule-router.jsonl.
REM Exit 1 = a dedupe break (a rule fired twice in one session): a router defect, read the report.

REM Self-redirect all output to a durable log; Task Scheduler discards the console.
set "LOG=C:\Users\david.hayes\continuous-claude\.claude\logs\rule-router-audit.log"

REM GOTO, not a parenthesized block: %ERRORLEVEL% inside ( ... ) expands before `call` runs
REM (see .claude/scripts/scheduled/scheduled-blocklist-update.bat, where that hid 28 failures).
if /i not "%~1"=="__LOGGED__" goto :RELAUNCH_LOGGED
goto :BODY

:RELAUNCH_LOGGED
call "%~f0" __LOGGED__ >> "%LOG%" 2>&1
exit /b %ERRORLEVEL%

:BODY
echo [%date% %time%] rule-router audit starting
cd /d C:\Users\david.hayes\continuous-claude
"C:\Program Files\nodejs\node.exe" scripts\rules\rule-router-audit.mjs --days 7
set "RC=%ERRORLEVEL%"
echo [%date% %time%] rule-router audit finished, exit %RC%
exit /b %RC%
