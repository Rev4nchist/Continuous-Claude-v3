# Notion Health-Check Update Prompt

> **DEPRECATED (2026-07-17).** `scripts/scheduled-health-check.bat` no longer feeds this
> prompt to `claude -p`. The Notion mirror is now the deterministic (ntn-only, NO MCP,
> NO LLM) `scripts/report-registry/health-mirror.mjs` — the mirror is ~90% mechanical,
> so the LLM round-trip added cost, non-determinism, and the headless-MCP permission-grant
> footgun that silently froze this pipeline for 11 weeks (see `.claude/rules-ondemand/headless-claude-mcp.md`).
> This file is retained for historical reference / as the spec of the section shapes the
> deterministic renderer reproduces. Do not wire it back into the batch file.

This prompt WAS fed to `claude -p` by `scripts/scheduled-health-check.bat` after each weekly
run of the CCv3 health check. It instructed Claude Code to mirror the latest results onto
the **CCv3 Weekly Health Checks** Notion dashboard.

---

You are a non-interactive `claude -p` session invoked by the Friday 08:03 scheduled
health-check task on Windows. A fresh health-check run just completed. Your job is to
update the CCv3 Weekly Health Checks Notion page with the results.

## Page

- Title: **CCv3 Weekly Health Checks**
- URL: https://www.notion.so/innovativemusings/CCv3-Weekly-Health-Checks-34c76fd7ac8280a984afc486a9844290
- ID: `34c76fd7-ac82-80a9-84af-c486a9844290`

## Steps

1. Find the newest `health_*.json` file in `C:/Users/david.hayes/continuous-claude/.claude/cache/health-checks/` by modified time. Use Glob + Read.
2. Extract from it: `timestamp`, `overall_status`, `counts.{PASS,WARN,FAIL,SKIP}`, `duration_s`, and the `results` array. Pick out:
   - the memory canary entry (`name == "memory-canary-roundtrip"`) — its `duration_ms` and `status`
   - the three critical-path entries: `docker-daemon-running`, `postgres-container-running`, `rlm-sandbox-image-present`
   - every entry with `status == "WARN"` or `status == "FAIL"` — for the WARN Breakdown and Suggested Actions
3. Fetch the Notion page to get current content.
4. Use `notion-update-page` with `command: update_content` to:
   - **Replace the Current Status table.** Match on the exact row text. Update: the week label in the heading (e.g. `## Current Status — Week of 2026-05-01`), Overall (use 🟢 PASS / 🟡 WARN / 🟠 HIGH_FAIL / 🔴 CRITICAL_FAIL emoji), Counts, Duration, NextRun (compute next Friday).
   - **Replace the Critical Path bullets** with the live evidence from this run's critical-path entries.
   - **Insert a new row at the top of the Run Log table**, immediately below the header row. Format: `| YYYY-MM-DD HH:MM | status-emoji STATUS | PASS/WARN/FAIL | duration | notes |`. The note should be a short (≤10 words) human summary — e.g. "Nominal weekly run" or "Docker recovered" or "BGE canary 60s — investigate".
   - **Replace the WARN Breakdown table** with a fresh one listing every WARN/FAIL from this run. Include a best-guess Age column (`pre-existing` if seen on the previous run, `new` otherwise).
   - **Refresh "Your Suggested Actions"**. Keep the existing HIGH/MEDIUM priority items unless they've been resolved (i.e. the corresponding WARN is gone this run). If a new CRITICAL or FAIL item appeared, add a top item for it. Preserve Recommendation lines.
5. **Do NOT touch** the `## Improvement Ideas` section or the `## Automation — How This Page Gets Updated` section.
6. When done, print exactly one line to stdout: `notion-health-update: OK status=<STATUS> counts=<P/W/F/S>` — or on error, `notion-health-update: FAILED reason=<short reason>` and exit 1.

## Guardrails

- If `notion-fetch` fails or the page ID is invalid, exit 1 without partial writes.
- If the Notion MCP server is unavailable (claude.ai Notion), print `notion-health-update: SKIP reason=mcp-unavailable` and exit 0 — the raw JSON/MD artifacts on disk are the source of truth regardless.
- Do not spawn subagents. This is a single-session update.
- Do not delete or restructure the page; only update the sections listed.
- Time-budget: 3 minutes. If any single MCP call takes longer than 60s, bail with a SKIP.
