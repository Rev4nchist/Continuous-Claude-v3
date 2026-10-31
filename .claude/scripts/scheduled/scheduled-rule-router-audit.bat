@echo off
setlocal
REM Weekly rule-router precision audit (Task Scheduler: CCv3-RuleRouter-Audit, Mondays 09:07).
REM Writes docs\self-improvement\audits\rule-router-<date>.md from ~/.claude/logs/rule-router.jsonl.
REM The report is gitignored (.gitignore: docs/self-improvement/audits/rule-router-*.md), so the run
REM never dirties the checkout.
REM Exit 1 = a dedupe break (a rule fired twice in one session) or an unreadable manifest: a router
REM defect, read the report.
REM
REM This file lives in the repo at .claude/scripts/scheduled/ and the forward sync installs it at
REM %USERPROFILE%\.claude\scripts\scheduled\. The task points at the installed copy. The audit script
REM lives in the repo (scripts\rules\) and is not synced, so this file finds the repo root first.
REM
REM Environment overrides, for a hand test:
REM   CCV3_RULE_ROUTER_REPO_ROOT  repo that holds scripts\rules\rule-router-audit.mjs (wins over the machine profile)
REM   CCV3_RULE_ROUTER_LOG        log file path
REM   CCV3_RULE_ROUTER_ARGS       extra audit arguments, e.g. --out <file> --log <file>

REM Self-redirect all output to a durable log; Task Scheduler discards the console.
REM GOTO, not a parenthesized block: %ERRORLEVEL% inside ( ... ) expands before `call` runs
REM (see scheduled-blocklist-update.bat in this folder, where that hid 28 failures).
if defined CCV3_RR_AUDIT_LOGGED goto :BODY

set "LOG=%USERPROFILE%\.claude\logs\rule-router-audit.log"
if defined CCV3_RULE_ROUTER_LOG set "LOG=%CCV3_RULE_ROUTER_LOG%"
for %%L in ("%LOG%") do if not exist "%%~dpL" mkdir "%%~dpL"

:RELAUNCH_LOGGED
set "CCV3_RR_AUDIT_LOGGED=1"
call "%~f0" %* >> "%LOG%" 2>&1
exit /b %ERRORLEVEL%

:BODY
set "CCV3_RR_AUDIT_LOGGED="
echo [%date% %time%] rule-router audit starting

set "NODE=node"
where node >nul 2>&1
if errorlevel 1 set "NODE=C:\Program Files\nodejs\node.exe"

REM The repo copy of this file is three folders below the repo root. The installed copy is not, so
REM fall back to the default checkout, then let the machine profile name the root.
set "BOOT=%~dp0..\..\.."
if not exist "%BOOT%\scripts\settings\machine-profile.mjs" set "BOOT=%USERPROFILE%\continuous-claude"
set "REPO_ROOT=%BOOT%"
REM One line per loop body; the set sits inside quotes, so a ")" in the value is safe.
REM The command is wrapped in a second pair of quotes: cmd /c drops the first and last quote of a command that starts with one,
REM so `"node" "path" args` alone breaks with "filename, directory name, or volume label syntax is incorrect".
for /f "usebackq tokens=1,* delims==" %%A in (`""%NODE%" "%BOOT%\scripts\settings\machine-profile.mjs" --export bat --quiet"`) do if /I "%%A"=="REPO_ROOT" (set "REPO_ROOT=%%B") else if /I "%%A"=="WARN" echo WARN: %%B
REM The override goes last so it wins over the machine profile.
if defined CCV3_RULE_ROUTER_REPO_ROOT set "REPO_ROOT=%CCV3_RULE_ROUTER_REPO_ROOT%"

set "BRANCH=unknown"
for /f "usebackq delims=" %%B in (`git -C "%REPO_ROOT%" rev-parse --abbrev-ref HEAD 2^>nul`) do set "BRANCH=%%B"
echo repo=%REPO_ROOT% branch=%BRANCH%

if not exist "%REPO_ROOT%\scripts\rules\rule-router-audit.mjs" goto :NO_AUDIT
cd /d "%REPO_ROOT%"
set "AUDIT_OUT=%TEMP%\ccv3-rule-router-audit-%RANDOM%.txt"
"%NODE%" scripts\rules\rule-router-audit.mjs --days 7 %CCV3_RULE_ROUTER_ARGS% > "%AUDIT_OUT%" 2>&1
set "RC=%ERRORLEVEL%"
type "%AUDIT_OUT%"
REM The console line says "N dedupe breaks"; the report says "Dedupe breaks: N". Log the report's form.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$m = [regex]::Match((Get-Content -Raw -ErrorAction SilentlyContinue $env:AUDIT_OUT), '(\d+) dedupe breaks'); if ($m.Success) { 'Dedupe breaks: ' + $m.Groups[1].Value } else { 'Dedupe breaks: unknown (no audit summary line)' }"
del "%AUDIT_OUT%" >nul 2>&1
echo [%date% %time%] rule-router audit finished, exit %RC%
exit /b %RC%

:NO_AUDIT
echo ERROR: audit script not found under %REPO_ROOT%\scripts\rules
exit /b 3
