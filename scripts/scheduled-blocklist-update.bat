@echo off
REM Daily package security blocklist update
REM Runs via Windows Task Scheduler at 9am
REM Updates malicious-packages.json from GitHub Advisory API, rebuilds hooks, commits, pushes, syncs

REM Self-redirect ALL output to a durable log (Task Scheduler discards the console, which is why
REM this task's daily exit-1 failures were undiagnosable). The re-invoke runs the real body below.
set "LOG=C:\Users\david.hayes\continuous-claude\.claude\logs\blocklist-update.log"

REM GOTO, not a parenthesized block. `%ERRORLEVEL%` inside ( ... ) is expanded when
REM the BLOCK is parsed -- before `call` has run -- so it always substituted the
REM errorlevel from BEFORE the inner invocation, i.e. 0. That is why Task Scheduler
REM reported "Last Result: 0" for 28 consecutive runs while the log recorded 24
REM [ERROR]s and zero completions: the failure was real, logged, and thrown away at
REM the last line. Outside a block, %ERRORLEVEL% expands per-line at execution time.
if /i not "%~1"=="__LOGGED__" goto :RELAUNCH_LOGGED
goto :BODY

:RELAUNCH_LOGGED
call "%~f0" __LOGGED__ >> "%LOG%" 2>&1
exit /b %ERRORLEVEL%

:BODY

echo [%date% %time%] Starting blocklist update...

cd /d C:\Users\david.hayes\continuous-claude

REM Pin gh to the personal account's own config dir. update-blocklist.mjs hard-gates on
REM `gh auth status` and then calls bare `gh api`, so it needs a credential of its own --
REM it used to borrow the ambient GITHUB_TOKEN, which is being removed. This repo's remote
REM is Rev4nchist/parcadei, so personal is the correct account (see scripts/github/accounts.json).
REM Inert while GITHUB_TOKEN still exists: gh precedence is GH_TOKEN > GITHUB_TOKEN > stored.
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"

REM Fetch latest advisories and update the blocklist
echo Fetching advisories from GitHub...
call node scripts/update-blocklist.mjs --apply
if errorlevel 1 (
    echo [ERROR] Blocklist update failed
    exit /b 1
)

REM Rebuild hooks with updated blocklist
echo Rebuilding hooks...
cd /d C:\Users\david.hayes\continuous-claude\.claude\hooks
call npm run build
if errorlevel 1 (
    echo [ERROR] Hook build failed
    exit /b 1
)

REM Commit if there are changes
cd /d C:\Users\david.hayes\continuous-claude
git add .claude/hooks/src/shared/malicious-packages.json .claude/hooks/dist/package-install-guard.mjs
git diff --cached --quiet
if not errorlevel 1 goto :NO_BLOCKLIST_CHANGES

REM PUSH THE BRANCH WE JUST COMMITTED TO -- not `main`.
REM This said `git push fork main`, which pushes the local `main` REF, while the
REM commit above lands on whatever branch is checked out (agentic-os for the whole
REM life of this job). Because local main was strictly BEHIND fork/main, git had
REM nothing to send and reported "Everything up-to-date" -- exit 0, a success line
REM in the log, and the blocklist commit never left the machine. Every automated
REM blocklist commit that reached the remote got there on someone's manual push.
REM
REM `HEAD` pushes the current branch to the same-named branch on fork, so the job
REM follows a branch switch instead of silently no-opping again.
echo Committing updated blocklist...
git commit -m "chore(security): daily blocklist update [automated]"
if errorlevel 1 goto :BLOCKLIST_COMMIT_FAILED

set "BRANCH=(unknown)"
for /f "usebackq tokens=*" %%B in (`git rev-parse --abbrev-ref HEAD`) do set "BRANCH=%%B"

git push fork HEAD
if errorlevel 1 goto :BLOCKLIST_PUSH_FAILED
echo Pushed to fork/%BRANCH%
goto :AFTER_BLOCKLIST_COMMIT

:NO_BLOCKLIST_CHANGES
echo No blocklist changes detected
goto :AFTER_BLOCKLIST_COMMIT

:BLOCKLIST_COMMIT_FAILED
echo [ERROR] Blocklist commit failed
exit /b 1

:BLOCKLIST_PUSH_FAILED
echo [ERROR] Push to fork/%BRANCH% failed -- the commit is local only
exit /b 1

:AFTER_BLOCKLIST_COMMIT

REM Sync to active ~/.claude/
echo Syncing to active directory...
bash scripts/sync-to-active.sh

echo [%date% %time%] Blocklist update complete
