@echo off
REM Start the Session Dashboard service
REM Called by Task Scheduler on logon

cd /d %USERPROFILE%\continuous-claude\opc\scripts
%USERPROFILE%\.local\bin\uv.exe run python -m dashboard.main
