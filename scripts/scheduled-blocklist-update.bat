@echo off
REM Daily package security blocklist update
REM Runs via Windows Task Scheduler at 9am (task CCv3-Blocklist-Update, cmd.exe /c <this file>)
REM
REM The work lives in scheduled-blocklist-update.ps1. It updates malicious-packages.json from the
REM GitHub Advisory API, rebuilds hooks, commits ONLY to main in a temporary worktree, pushes to
REM fork main, fast-forwards local main and syncs ~/.claude. It never touches the primary
REM checkout's branch or working tree. This file only keeps the durable log and the exit code.
REM
REM Optional arguments are passed to the .ps1, e.g. -RepoPath <test clone> -NoSync.

REM Self-redirect ALL output to a durable log (Task Scheduler discards the console, which is why
REM this task's daily exit-1 failures were undiagnosable). The re-invoke runs the real body below.
set "LOG=C:\Users\david.hayes\continuous-claude\.claude\logs\blocklist-update.log"
if defined BLOCKLIST_LOG set "LOG=%BLOCKLIST_LOG%"

REM GOTO, not a parenthesized block. `%ERRORLEVEL%` inside ( ... ) is expanded when
REM the BLOCK is parsed -- before `call` has run -- so it always substituted the
REM errorlevel from BEFORE the inner invocation, i.e. 0. That is why Task Scheduler
REM reported "Last Result: 0" for 28 consecutive runs while the log recorded 24
REM [ERROR]s and zero completions. Outside a block, %ERRORLEVEL% expands per-line.
if /i not "%~1"=="__LOGGED__" goto :RELAUNCH_LOGGED
goto :BODY

:RELAUNCH_LOGGED
call "%~f0" __LOGGED__ %* >> "%LOG%" 2>&1
exit /b %ERRORLEVEL%

:BODY
set "PS1=%~dp0scheduled-blocklist-update.ps1"
REM Drop the __LOGGED__ marker so %* holds only the caller's arguments.
shift

REM powershell.exe (5.1) ships with Windows; Task Scheduler's PATH does not reliably include pwsh.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%
