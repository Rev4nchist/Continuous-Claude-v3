@echo off
REM ============================================================================
REM scheduled-youtube-poll.bat — nightly watchlist poll + ingest.
REM
REM Registered as Windows Task Scheduler job "CCv3-YouTube-Poll".
REM
REM This wrapper is pure Node (yt-dlp + fs). It does NOT call `claude -p` and
REM does NOT touch MCP, so the ANTHROPIC_API_KEY / --allowedTools contract in
REM .claude/rules/headless-claude-mcp.md does not apply here. What DOES apply is
REM the rest of that rule's wrapper conventions, which are honored below:
REM   - capture stdout AND stderr to a dated log (never discard output)
REM   - never derive success from exit code alone; verify the artifact
REM
REM Deliberate scope limit: this job GATHERS ONLY. It never synthesizes a digest.
REM Raising `pendingDigest` is the whole output; you decide what earns a /yt dig.
REM ============================================================================

setlocal

set "REPO=C:\Users\david.hayes\continuous-claude"
set "LOGDIR=%USERPROFILE%\.claude\logs\youtube-poll"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM Dated log: YYYY-MM-DD from ISO-ish locale-independent WMIC-free method.
for /f "tokens=2 delims==" %%I in ('wmic os get LocalDateTime /value 2^>nul ^| find "="') do set "DT=%%I"
set "TODAY=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%"
set "LOG=%LOGDIR%\%TODAY%.log"

echo ============================================================ >> "%LOG%" 2>&1
echo [%DATE% %TIME%] youtube poll starting                        >> "%LOG%" 2>&1

pushd "%REPO%"

REM --ingest pulls genuinely new uploads; --json gives the machine-readable
REM result that the verification step below reads.
node "scripts\youtube\poll.mjs" --ingest --json >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"

echo [%DATE% %TIME%] poll.mjs exited %RC%                          >> "%LOG%" 2>&1

REM Artifact verification — exit 0 alone is NOT proof the poll did anything
REM meaningful (it covers "no active channels" and "all skipped"). status.mjs
REM reads the real corpus, so a corrupted or empty corpus surfaces here.
node "scripts\youtube\status.mjs" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%DATE% %TIME%] VERIFY FAILED: status.mjs could not read the corpus >> "%LOG%" 2>&1
  set "RC=1"
)

popd

echo [%DATE% %TIME%] youtube poll finished rc=%RC%                 >> "%LOG%" 2>&1
endlocal & exit /b %RC%
