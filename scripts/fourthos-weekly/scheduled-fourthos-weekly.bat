@echo off
REM Weekly FourthOS sponsor update package (Carly & Christian)
REM Registered in Windows Task Scheduler as "CCv3-FourthOS-Weekly"
REM Runs every Friday at 07:00am (local time)
REM Stages an UNLISTED preview to the ai-enablement-decks GitHub Pages site and pings Dave.
REM It deliberately does NOT promote to the live sponsor URL -- that is Dave's approval step:
REM     node scripts\fourthos-weekly\promote.mjs
REM Run manually: schtasks /run /tn "CCv3-FourthOS-Weekly"

cd /d C:\Users\david.hayes\continuous-claude
set GEN_PROMPT=scripts\fourthos-weekly\generate-prompt.md

echo [%date% %time%] Starting FourthOS weekly sponsor update generation...

if not exist %GEN_PROMPT% (
    echo [%date% %time%] FAIL: %GEN_PROMPT% not found -- aborting.
    exit /b 1
)

REM Feed the generate prompt to a non-interactive claude -p session. The prompt instructs
REM Claude Code to read the FourthOS Notion cockpit, refresh the Tier-3 Update Package page,
REM render the Tier-1 dashboard + Tier-2 deep-dive, stage them to fourthos/preview/ (unlisted),
REM and notify Dave via Slack + a Notion comment. Fail-loud guards live inside the prompt.
type %GEN_PROMPT% | call claude -p --output-format text
set EXIT_CODE=%ERRORLEVEL%

echo [%date% %time%] FourthOS weekly generation finished. exit=%EXIT_CODE%

REM Exit code contract (mirrors the prompt's final stdout line):
REM   0 = OK (preview staged + Dave notified)  OR  SKIP (Notion MCP unavailable; nothing published)
REM   1 = FAILED (see Slack/Notion notice and fourthos/preview/_ERROR.md in the decks repo)
REM The stable live sponsor deck is never overwritten by this task; promotion is manual.

exit /b %EXIT_CODE%
