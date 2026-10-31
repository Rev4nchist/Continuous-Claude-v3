@echo off
setlocal
REM Daily CCv3 harness health check (Task Scheduler: CCv3-Health-Check, daily 07:50, cmd.exe /c <this file>).
REM
REM This file lives in the repo at .claude/scripts/scheduled/ and the forward sync installs it at
REM %USERPROFILE%\.claude\scripts\scheduled\. The task points at that installed copy, so the job that
REM runs is always main's version. The doctor itself lives in the repo (scripts\harness-doctor.mjs) and
REM is not synced, so this file finds the repo root first.
REM
REM It runs harness-doctor (read-only: no Docker, no network, no paid call) with --json, writes the
REM newest result to %USERPROFILE%\.claude\state\health\latest.json and exits with the doctor's exit
REM code (1 on any FAIL, 2 on a bad argument, 124 when the doctor ran past its time limit).
REM
REM Environment overrides, for a hand test that must not touch the real ~/.claude or the primary checkout:
REM   CCV3_HEALTH_REPO_ROOT    repo that holds scripts\harness-doctor.mjs (wins over the machine profile)
REM   CCV3_HEALTH_OUT          latest.json path; the value "-" omits --out (a doctor without --out)
REM   CCV3_HEALTH_LOG          log file path
REM   CCV3_HEALTH_EXTRA_ARGS   extra doctor arguments, e.g. --home <dir> to force a failure
REM   CCV3_HEALTH_TIMEOUT_SEC  doctor time limit in seconds (default 480; the task limit is 10 minutes)

REM Self-redirect ALL output to a durable log (Task Scheduler discards the console). The re-invoke
REM runs the real body below. GOTO, not a parenthesized block: %ERRORLEVEL% inside ( ... ) expands
REM before `call` runs, which hid 28 failures in scheduled-blocklist-update.bat.
if defined CCV3_HEALTH_LOGGED goto :BODY

set "LOGDATE="
for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"`) do set "LOGDATE=%%d"
set "LOG=%USERPROFILE%\.claude\logs\health-check\last-run.log"
if defined LOGDATE set "LOG=%USERPROFILE%\.claude\logs\health-check\%LOGDATE%.log"
if defined CCV3_HEALTH_LOG set "LOG=%CCV3_HEALTH_LOG%"
for %%L in ("%LOG%") do if not exist "%%~dpL" mkdir "%%~dpL"

:RELAUNCH_LOGGED
set "CCV3_HEALTH_LOGGED=1"
call "%~f0" %* >> "%LOG%" 2>&1
exit /b %ERRORLEVEL%

:BODY
set "CCV3_HEALTH_LOGGED="
echo [%date% %time%] health check starting

set "NODE=node"
where node >nul 2>&1
if errorlevel 1 set "NODE=C:\Program Files\nodejs\node.exe"

REM Find the repo. The repo copy of this file is three folders below the repo root. The installed copy
REM is not, so fall back to the default checkout, then let the machine profile name the root.
set "BOOT=%~dp0..\..\.."
if not exist "%BOOT%\scripts\settings\machine-profile.mjs" set "BOOT=%USERPROFILE%\continuous-claude"
set "REPO_ROOT=%BOOT%"
REM One line per loop body; the set sits inside quotes, so a ")" in the value is safe.
REM The command is wrapped in a second pair of quotes: cmd /c drops the first and last quote of a command that starts with one,
REM so `"node" "path" args` alone breaks with "filename, directory name, or volume label syntax is incorrect".
for /f "usebackq tokens=1,* delims==" %%A in (`""%NODE%" "%BOOT%\scripts\settings\machine-profile.mjs" --export bat --quiet"`) do if /I "%%A"=="REPO_ROOT" (set "REPO_ROOT=%%B") else if /I "%%A"=="WARN" echo WARN: %%B
REM The override goes last so it wins over the machine profile.
if defined CCV3_HEALTH_REPO_ROOT set "REPO_ROOT=%CCV3_HEALTH_REPO_ROOT%"

set "DOCTOR=%REPO_ROOT%\scripts\harness-doctor.mjs"
if not exist "%DOCTOR%" goto :NO_DOCTOR

set "OUT=%USERPROFILE%\.claude\state\health\latest.json"
if defined CCV3_HEALTH_OUT set "OUT=%CCV3_HEALTH_OUT%"
set "HD_ARGS="%DOCTOR%" --json"
if "%OUT%"=="-" goto :OUT_DONE
for %%O in ("%OUT%") do if not exist "%%~dpO" mkdir "%%~dpO"
set "HD_ARGS=%HD_ARGS% --out "%OUT%""
:OUT_DONE
set "HD_ARGS=%HD_ARGS% --repo "%REPO_ROOT%""
if defined CCV3_HEALTH_EXTRA_ARGS set "HD_ARGS=%HD_ARGS% %CCV3_HEALTH_EXTRA_ARGS%"

set "BRANCH=unknown"
for /f "usebackq delims=" %%B in (`git -C "%REPO_ROOT%" rev-parse --abbrev-ref HEAD 2^>nul`) do set "BRANCH=%%B"
echo repo=%REPO_ROOT% branch=%BRANCH% out=%OUT%
echo doctor: %NODE% %HD_ARGS%

REM Bounded run. A Task Scheduler limit kill does not reap the child tree on this machine, so the
REM limit lives here: wait, then kill the one child pid. Never taskkill /T, so a node or git child that
REM the doctor's own spawnSync calls started can outlive the kill (accepted; it ends with its command). $p.Handle is read first
REM because without it .ExitCode can come back empty, which would swallow the doctor's exit code.
set "HD_NODE=%NODE%"
set "HD_SEC=480"
if defined CCV3_HEALTH_TIMEOUT_SEC set "HD_SEC=%CCV3_HEALTH_TIMEOUT_SEC%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath $env:HD_NODE -ArgumentList $env:HD_ARGS -NoNewWindow -PassThru; $null = $p.Handle; if ($p.WaitForExit([int]$env:HD_SEC * 1000)) { exit $p.ExitCode } else { Stop-Process -Id $p.Id -Force; Write-Output 'TIMEOUT: doctor killed'; exit 124 }"
set "RC=%ERRORLEVEL%"

REM D6: toast on FAIL only. health-toast.ps1 reads the report, stays quiet for PASS and WARN and for a
REM fail set it already showed, and always exits 0. Its exit code is ignored here so the toast can
REM never change the task exit code. Skipped when there is no report ("-"). CCV3_HEALTH_TOAST_ARGS adds
REM toast arguments, e.g. -DryRun -StateFile <temp> for a hand test.
if not "%OUT%"=="-" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0health-toast.ps1" -Latest "%OUT%" %CCV3_HEALTH_TOAST_ARGS%
echo [%date% %time%] health check finished, exit %RC%
exit /b %RC%

:NO_DOCTOR
echo ERROR: doctor not found at %DOCTOR%
exit /b 3
