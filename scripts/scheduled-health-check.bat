@echo off
REM Weekly CCv3 harness health check.
REM Registered as CCv3-Health-Check. Paths come from the machine profile.
REM Harness checks only. The Fourth report registry is not called.
setlocal
set "REPO=%~dp0.."
set "NODE=node"
where node >nul 2>&1
if errorlevel 1 set "NODE=C:\Program Files\nodejs\node.exe"

set "USER_HOME=%USERPROFILE%"
set "OPC_DIR=%REPO%\opc"
set "CLAUDE_HOME=%USERPROFILE%\.claude"
for /f "usebackq tokens=1,* delims==" %%A in (`"%NODE%" "%REPO%\scripts\settings\machine-profile.mjs" --export bat --quiet`) do (
  if /I "%%A"=="USER_HOME" set "USER_HOME=%%B"
  if /I "%%A"=="REPO_ROOT" set "REPO=%%B"
  if /I "%%A"=="OPC_DIR" set "OPC_DIR=%%B"
  if /I "%%A"=="CLAUDE_HOME" set "CLAUDE_HOME=%%B"
  if /I "%%A"=="WARN" echo WARN: %%B
)

set "CLAUDE_OPC_DIR=%OPC_DIR%"
set "NLOG_DIR=%CLAUDE_HOME%\logs\health-check"
if not exist "%NLOG_DIR%" mkdir "%NLOG_DIR%"
set "NLOG_DATE="
for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"`) do set "NLOG_DATE=%%d"
if defined NLOG_DATE (set "NLOG=%NLOG_DIR%\%NLOG_DATE%.log") else (set "NLOG=%NLOG_DIR%\last-run.log")

cd /d "%OPC_DIR%"
set PYTHONPATH=.
echo [%date% %time%] Starting CCv3 weekly health check...>> "%NLOG%"
call uv run python scripts\health_check.py --skip-slow --quiet >> "%NLOG%" 2>&1
set EXIT_CODE=%ERRORLEVEL%
echo [%date% %time%] Health check finished. exit=%EXIT_CODE%>> "%NLOG%"
exit /b %EXIT_CODE%
