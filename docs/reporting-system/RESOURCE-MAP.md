# Reporting System — Resource Map

Everything the effort touches: filesystem, live artifacts, Notion, and operational commands.

## Filesystem map (continuous-claude, on `snapshot/reporting-system`)

```
.claude/skills/reporting/SKILL.md           # Code reporting discipline (one-spine rule)
.claude/skills/log-work/SKILL.md            # primitive: write one Tracker row
.claude/skills/notion-bridge/notion-bridge/ # Eve/Donna/Code queues + auto-mirror (step 3b)
    SKILL.md, references/bridge-schema.md
.claude/skills/weekly-report/SKILL.md       # team cut (Code data half) — uses ai-reporting MCP
.claude/skills/fourthos-weekly/             # sponsor cut
    SKILL.md, templates/shell.html, templates/README.md
scripts/fourthos-weekly/
    generate-prompt.md                      # headless prompt piped to `claude -p` (Fri 07:00)
    promote.mjs                             # preview/ → fourthos/<date>/ + decks.json card + push
    scheduled-fourthos-weekly.bat           # CCv3-FourthOS-Weekly task entry point
docs/reporting/
    reporting-system-overview.md            # CANONICAL map + "one spine, two cuts" proposal
    donna-reporting-addendum.md             # paste-ready Donna instruction
docs/reporting-system/                      # THIS orientation library (README/CURRENT-STATE/PLAN/RESOURCE-MAP)
docs/HANDOFF-2026-06-27-reporting-system.md # session handoff
.claude/docs/architecture/cheatsheet.md     # scheduled-task inventory (CCv3-FourthOS-Weekly row)
```

## Sibling repos (NOT in continuous-claude)

| Repo | Path | Role |
|---|---|---|
| ai-reporting-mcp | `C:/Users/david.hayes/ai-reporting-mcp/` | the `ai-reporting` MCP server (`server.py`, `config.py`, `collectors/tracker_collector.py`). Reads `NOTION_TOKEN`. |
| ai-reporting-dashboard | `C:/Users/david.hayes/Projects/ai-reporting-dashboard/` | Next.js 15 + Drizzle + NeonDB team dashboard (Railway) |
| ai-enablement-decks | `C:/Users/david.hayes/Projects/ai-enablement-decks/` | PUBLIC GitHub Pages: sponsor decks + the reporting-system doc deck |

## Live artifacts (URLs)

- **Team dashboard:** https://ai-reporting-dashboard-production.up.railway.app/
- **Sponsor site (hub):** https://rev4nchist.github.io/ai-enablement-decks/  → `#sponsor-updates`
- **Sponsor deck (latest):** https://rev4nchist.github.io/ai-enablement-decks/fourthos/2026-06-24/
- **Reporting-system doc deck** *(published this session via the decks repo's GitHub Pages auto-deploy
  on push — intended; it's the web copy of `docs/reporting/reporting-system-overview.md`):*
  https://rev4nchist.github.io/ai-enablement-decks/reporting-system/
  (+ editable diagram: `…/reporting-system/reporting-system.excalidraw`)

## Notion (claude.ai Notion MCP — 14 tools)

| Entity | ID |
|---|---|
| Bridge HQ (Eve/Donna/Code queues + Implementation Log) | `30e76fd7ac8281e99fe1c0b257088b34` |
| **Weekly Work Tracker DB (the SPINE)** | `3d7f2afd6c5046748408e4412a5552b2` (data-source `6e8d9b17-f8ef-4d56-9f13-00344650ac03`) |
| FourthOS Daily Cockpit | `34076fd7-ac82-805d-ac89-dd26476e2c47` |
| Leadership Portfolio Dashboard (5 DBs) | `e29dd1c4-e6a6-4e39-a454-73525a765e5e` |
| Update Package prompt (Tier-3 spec) | `82c202b8-2b66-4953-a87d-0177eee58172` |
| Connector Ecosystem master plan | `38776fd7-ac82-81c7-a286-ce6ae478b6be` |

## Operational commands (PowerShell — git via PowerShell; bash shell init can stall)

```
# Get on this effort's branch (fresh session)
git -C C:\Users\david.hayes\continuous-claude fetch fork
git -C C:\Users\david.hayes\continuous-claude checkout snapshot/reporting-system

# Sponsor cut — manual run / promote
type scripts\fourthos-weekly\generate-prompt.md | claude -p --output-format text
node scripts\fourthos-weekly\promote.mjs            # --dry-run / --no-push / --date=YYYY-MM-DD

# Team cut — after NOTION_TOKEN is set + Claude Code restarted
#   run the /weekly-report skill in Claude Code (Phase 1 collect_weekly_work_tracker)

# ai-reporting MCP — smoke test (sibling repo)
uv run --directory C:/Users/david.hayes/ai-reporting-mcp python -c "import server; print('ok')"

# Scheduled task
schtasks /query /tn "CCv3-FourthOS-Weekly"
```

## Key external dependency
`NOTION_TOKEN` (Notion internal integration secret, Tracker DB shared to it) — required for the team
dashboard + the FourthOS-run-logs-to-Tracker step. Set via `setx NOTION_TOKEN "ntn_…"` then restart.
