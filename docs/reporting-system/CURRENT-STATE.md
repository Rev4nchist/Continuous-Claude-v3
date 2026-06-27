# Reporting System — Current State (2026-06-27)

What exists today, and what's wired vs not. Status tags: ✅ live · 🟡 built-not-wired · 🔴 gap.

## Built this session (commit `6592d46` → cherry-picked as `e886f93` on this branch)

| Component | Path | State |
|---|---|---|
| **`reporting` skill** (Code reporting discipline) | `.claude/skills/reporting/SKILL.md` | ✅ active (synced to `~/.claude`) |
| **Reporting-system overview** (canonical map + proposal) | `docs/reporting/reporting-system-overview.md` | ✅ |
| **Donna addendum** (paste-ready) | `docs/reporting/donna-reporting-addendum.md` | 🟡 written; **not yet given to Donna** |
| **fourthos-weekly pipeline** (sponsor cut) | `.claude/skills/fourthos-weekly/` + `scripts/fourthos-weekly/` | ✅ scheduled `CCv3-FourthOS-Weekly` Fri 07:00 |
| Scheduled-task inventory row | `.claude/docs/architecture/cheatsheet.md` | ✅ |

## The spine + the two outputs

- **Weekly Work Tracker** (Notion DB `3d7f2afd`, data-source `6e8d9b17`) — ✅ exists; fields per README.
  The reporting spine. Populated today by: `log-work` (manual) + Bridge auto-mirror (Code writebacks).
- **Team dashboard** — Railway/NeonDB Next.js app at `ai-reporting-dashboard-production.up.railway.app`
  (project `C:/Users/david.hayes/Projects/ai-reporting-dashboard`). Driven by `/weekly-report` +
  the `ai-reporting` MCP (`C:/Users/david.hayes/ai-reporting-mcp`). 🟡 **see gap #1.**
- **Sponsor site** — `rev4nchist.github.io/ai-enablement-decks/fourthos/<date>/` (repo
  `C:/Users/david.hayes/Projects/ai-enablement-decks`). ✅ generation scheduled + headless; promote manual.
- **Live doc deck** (this system, documented) — `…/ai-enablement-decks/reporting-system/` ✅ published.

## Wired vs not — the gaps (these are the PLAN targets)

1. 🔴→🟡 **`ai-reporting` MCP: registered, pending token.** Now registered in `~/.mcp.json` (stdio,
   `uv run --directory C:/Users/david.hayes/ai-reporting-mcp python server.py`, `NOTION_TOKEN` via
   `${NOTION_TOKEN}`) and import-smoke-tested. **Blocked on a Notion integration token** —
   `NOTION_TOKEN` is unset everywhere; the `claude.ai Notion` OAuth (Bridge) is a *different* mechanism
   and can't be reused. Until Dave creates an internal integration + shares the Tracker DB + `setx
   NOTION_TOKEN` + restarts Claude Code, `/weekly-report` Phase 1 errors. **The team pipeline is down until then.**
2. 🔴 **No shared spine.** The sponsor site reads the FourthOS Cockpit, NOT the Tracker; the scheduled
   FourthOS run **never logs a Tracker row** → sponsor work is invisible to the team report.
3. 🔴 **Eve & Donna have no Tracker path.** `Source=Eve/Donna` exist in the schema but nothing writes
   them; their work reaches the Tracker only via a Code writeback. (Donna addendum fixes Donna once placed.)
4. 🔴 **Capture is manual / un-enforced.** `/log-work` + the auto-mirror depend on the model remembering;
   no hook enforces capture.
5. ℹ️ **`ai-reporting-mcp` lives outside the repo** (`C:/Users/david.hayes/ai-reporting-mcp/`, sibling
   to continuous-claude) — `config.py` reads `NOTION_TOKEN` from env, does NOT load `.env`.

## Branch / packaging state
- This effort: branch **`snapshot/reporting-system`** off `main` (`f7f3eba`), one cherry-picked commit
  `e886f93` (the 10 reporting-system files) + this packaging commit. Pushed to `fork`.
- Origin session commit `6592d46` still sits on `feature/cma-integration` (shared, dirty) — that branch
  also carries unrelated cma + viz work that must NOT ship with this effort.
