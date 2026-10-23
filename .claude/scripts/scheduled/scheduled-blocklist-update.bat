@echo off
setlocal
REM Daily package security blocklist update
REM Runs via Windows Task Scheduler at 9am (task CCv3-Blocklist-Update, cmd.exe /c <this file>)
REM
REM This file lives in the repo at .claude/scripts/scheduled/ and the forward sync installs it at
REM %USERPROFILE%\.claude\scripts\scheduled\. The task points at that installed copy, so the job
REM that runs is always main's version, whatever branch the primary checkout has. Register the task
REM with register-blocklist-task.ps1 (same folder).
REM
REM The work lives in scheduled-blocklist-update.ps1 (same folder). It updates malicious-packages.json
REM from the GitHub Advisory API, rebuilds hooks, commits ONLY to main in a temporary worktree, pushes
REM to fork main, fast-forwards local main and syncs ~/.claude. It never touches the primary
REM checkout's branch or working tree. This file only keeps the durable log and the exit code.
REM
REM Optional arguments are passed to the .ps1 unchanged, e.g. -RepoPath <test clone> -NoSync.

REM Self-redirect ALL output to a durable log (Task Scheduler discards the console, which is why
REM this task's daily exit-1 failures were undiagnosable). The re-invoke runs the real body below.
set "LOG=%USERPROFILE%\continuous-claude\.claude\logs\blocklist-update.log"
if defined BLOCKLIST_LOG set "LOG=%BLOCKLIST_LOG%"

REM GOTO, not a parenthesized block. `%ERRORLEVEL%` inside ( ... ) is expanded when
REM the BLOCK is parsed -- before `call` has run -- so it always substituted the
REM errorlevel from BEFORE the inner invocation, i.e. 0. That is why Task Scheduler
REM reported "Last Result: 0" for 28 consecutive runs while the log recorded 24
REM [ERROR]s and zero completions. Outside a block, %ERRORLEVEL% expands per-line.
REM
REM The logged re-invocation is marked with an environment variable, not a first argument.
REM `shift` does not change %*, and %1..%9 drop everything after the ninth argument.
REM setlocal above keeps the marker out of the caller's shell.
if defined CCV3_BLOCKLIST_LOGGED goto :BODY

:RELAUNCH_LOGGED
set "CCV3_BLOCKLIST_LOGGED=1"
call "%~f0" %* >> "%LOG%" 2>&1
exit /b %ERRORLEVEL%

:BODY
set "CCV3_BLOCKLIST_LOGGED="
set "PS1=%~dp0scheduled-blocklist-update.ps1"

REM powershell.exe (5.1) ships with Windows; Task Scheduler's PATH does not reliably include pwsh.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
exit /b %ERRORLEVEL%
