@echo off
REM Daily continuous-content refresh. Collection, read-only model analysis,
REM coverage validation, and draft packages only. No target apply or publish.
setlocal
set "REPO=C:\Users\david.hayes\continuous-claude"
set "YT_PYTHON_EXE=%REPO%\.venv\Scripts\python.exe"
set "TESSERACT_EXE=C:\Program Files\Tesseract-OCR\tesseract.exe"
set "YT_WHISPER_DEVICE=cpu"
set "YT_WHISPER_COMPUTE_TYPE=int8"
set "YT_WHISPER_MODEL=medium.en"
set "YT_PLAYLIST_ALLOWLIST_PATH=%REPO%\scripts\youtube\state\continuous-playlists.json"
set "YT_COOKIES_FILE=%USERPROFILE%\.claude\secrets\youtube-cookies.txt"
set "LOGDIR=%USERPROFILE%\.claude\logs\youtube-refresh"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
for /f "tokens=2 delims==" %%I in ('wmic os get LocalDateTime /value 2^>nul ^| find "="') do set "DT=%%I"
set "TODAY=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%"
set "LOG=%LOGDIR%\%TODAY%.log"
pushd "%REPO%"
echo [%DATE% %TIME%] youtube refresh starting >> "%LOG%" 2>&1
set "RC=0"
node "scripts\youtube\source.mjs" sync-allowlist >> "%LOG%" 2>&1
if errorlevel 1 set "RC=%ERRORLEVEL%"
node "scripts\youtube\refresh.mjs" --allowlist-only >> "%LOG%" 2>&1
if errorlevel 1 set "RC=%ERRORLEVEL%"
node -e "const r=require('./scripts/youtube/logs/refresh-latest.json'); if(!['NoChange','Ready','Blocked','Warn','Failed'].includes(r.status)) process.exit(1)" >> "%LOG%" 2>&1
if errorlevel 1 set "RC=1"
node "scripts\youtube\status.mjs" >> "%LOG%" 2>&1
if errorlevel 1 set "RC=1"
echo [%DATE% %TIME%] youtube refresh finished rc=%RC% >> "%LOG%" 2>&1
popd
endlocal & exit /b %RC%
