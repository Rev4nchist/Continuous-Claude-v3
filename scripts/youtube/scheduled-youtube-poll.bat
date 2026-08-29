@echo off
REM Compatibility path for the existing CCv3-YouTube-Poll scheduled task.
REM The continuous refresh wrapper preserves logs, validates durable status, and
REM never applies or publishes target changes.
call "%~dp0scheduled-youtube-refresh.bat"
exit /b %ERRORLEVEL%
