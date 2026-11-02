@echo off
setlocal
REM Daily review shadow sync (task CCv3-Review-Shadow, cmd.exe /c <this file>, daily 07:00 local)
REM
REM This file lives in the repo at .claude/scripts/scheduled/ and the forward sync installs it at
REM %USERPROFILE%\.claude\scripts\scheduled\. The task points at that installed copy.
REM
REM Daily: shadow sync (pair new CodeRabbit rounds with engine records). Monday: also scorecard and decide.
REM It reads the repo copy of the eval code at %CCV3_REPO% (default %USERPROFILE%\continuous-claude) on main.
REM It never blocks READY or land. Live sync stays off until the retro has 20 paired rows and the P0 judge passes:
REM the node script exits 0 with "sync is off" until then.
REM
REM Exit code: the first non-zero exit of sync / scorecard / decide, except decide exit 3 (repromote), which is a
REM finding and not a task failure: it is logged and the task exits 0.

set "REPO=%CCV3_REPO%"
if not defined REPO set "REPO=%USERPROFILE%\continuous-claude"
set "LOG=%USERPROFILE%\continuous-claude\.claude\logs\review-shadow.log"
if defined REVIEW_SHADOW_LOG set "LOG=%REVIEW_SHADOW_LOG%"

if defined CCV3_SHADOW_LOGGED goto :BODY
set "CCV3_SHADOW_LOGGED=1"
call "%~f0" %* >> "%LOG%" 2>&1
exit /b %ERRORLEVEL%

:BODY
set "CCV3_SHADOW_LOGGED="
set "CLI=%REPO%\scripts\eval\review-eval\cli.mjs"
if not exist "%CLI%" (
  echo [%DATE% %TIME%] review-shadow: missing %CLI%
  exit /b 1
)

echo [%DATE% %TIME%] review-shadow: sync
node "%CLI%" shadow sync --to latest %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [%DATE% %TIME%] review-shadow: sync exit %RC%
  exit /b %RC%
)

REM Monday only. %DATE% starts with the weekday on en-US Windows (for example "Mon 11/02/2026").
echo %DATE% | findstr /b /i "Mon" >nul
if errorlevel 1 exit /b 0

echo [%DATE% %TIME%] review-shadow: scorecard
node "%CLI%" shadow scorecard
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [%DATE% %TIME%] review-shadow: scorecard exit %RC%
  exit /b %RC%
)

echo [%DATE% %TIME%] review-shadow: decide
node "%CLI%" shadow decide --band HIGH
set "RC=%ERRORLEVEL%"
if "%RC%"=="3" (
  echo [%DATE% %TIME%] review-shadow: decide says repromote HIGH; band-state.json written; a session opens the config PR
  exit /b 0
)
exit /b %RC%
