---
name: reporting
description: Reporting discipline and /reporting ops (status, run, heal) for the Weekly Work Tracker spine. Use when finishing reportable work, at session end, or the user asks "/reporting status", "is reporting healthy", "log this for the report".
---

# Reporting Discipline (Claude Code)

**The whole system is "capture once, report many."** Reporting quality is a *capture* problem — the
renderers (team dashboard + sponsor site) are already good. Your job here is to make sure every
reportable unit of work lands in the **one spine**: the AI Enablement Weekly Work Tracker.

See the full system map + improvement proposal: `docs/reporting/reporting-system-overview.md`.

## The one rule

> After any reportable unit of work, ensure **exactly one** Weekly Work Tracker row exists for it,
> with `Source = Code`.

"Reportable" = a `Ship · Fix · Feature · Integration · Deploy · Decision · Research · Design` unit a
sponsor or the team would want to see. Not every edit — the shippable/decision-worthy ones.

## Two ways a row gets created (don't double-log)

| Situation | Path | You do |
|---|---|---|
| Work done as a **Bridge writeback** to Eve/Donna | `notion-bridge` **auto-mirror** (step 3b) creates the row | Follow the Bridge writeback protocol — the row is automatic. Verify it landed. |
| Work **not** going through a Bridge writeback (most CCv3 work) | `/log-work` skill | Invoke `/log-work` (or the log-work field call) to create the row |

**Dedup:** both paths dedup by `Writeback URL`. If a Bridge writeback already mirrored a row, do **not**
also `/log-work` the same item.

## Field mapping (every row)

| Field | Value |
|---|---|
| **Title** | verb-led, specific (e.g. "Wired interactive 3-view reporting toggle") |
| **Source** | `Code` (autonomous Code work) — `Dave`/`Team` only if attributing to a human |
| **Type** | `Ship · Fix · Feature · Integration · Deploy · Decision · Research · Design · Meeting` |
| **Impact** | `High · Mid · Low` (default Mid) |
| **Date** | the work date (today) |
| **Dashboard Section** | drives which report section it surfaces in (table below) |
| **Project** | relation to the relevant FourthOS Project, when one applies |
| **Commits** | SHA(s) if code shipped |
| **Writeback URL** | the Bridge child page / PR / artifact URL, if any |
| **Published in Report** | leave **unchecked** — the `collect_weekly_work_tracker` collector sets it |

### Dashboard Section decision table
`Highlight` (headline win) · `Decision` (made/needed) · `Deep Dive` (named project progress) ·
`Integration` (connected systems) · `Metric` (a number) · `Adoption` (usage/rollout) ·
`Roadmap` (forward plan) · `None` (logged, not for the report).

## The one-spine rule includes FourthOS work

The scheduled `fourthos-weekly` sponsor run writes the Notion cockpit but historically did **not** log
to the Tracker. Per the "one spine, two cuts" model: **any reportable FourthOS work should also land a
Tracker row** (`Source=Code`, `Dashboard Section=Highlight`) so it appears in the team report too. If
you ship sponsor-facing work outside the scheduled run, log it here.

**Refresh the living card too.** After reportable work on a FourthOS project that has a living status
card, run `/project-card refresh "<project>"` so its Notion card reflects the change (the daily
`CCv3-Project-Cards` sweep will catch it otherwise, but refresh now if it's report-worthy). The card is
a machine mirror — you change the source data (Projects DB / Decisions & Outputs), the card regenerates;
never hand-edit the card embed. See the `project-card` skill.

## How this feeds reporting

- **Team dashboard** (`/weekly-report`): `collect_weekly_work_tracker` reads unpublished Tracker rows,
  groups them by `Dashboard Section`, and marks them published. Your rows ARE the report.
- **Sponsor site** (`fourthos-weekly`): renders the VP/CTO cut; as the system unifies, the Tracker's
  "what shipped" signal feeds the sponsor "What moved" lane.
- **Prereq:** the `ai-reporting` MCP must be registered for `/weekly-report` to run (see overview §3 —
  currently unregistered; flag it if the collector errors).

## Session-end habit

Before ending a substantive session, ask: *"What did I ship/decide that isn't yet a Tracker row?"* —
then log it. Unlogged work is invisible to every report.

---

# Reporting Operations (`/reporting status | run | heal`) — proposal 07

The 60-second answer to "is the reporting system healthy?" plus the common operations, as
muscle memory. All commands are Windows-safe; ntn calls in scripts already handle the
`</dev/null` contract internally. Deep background: `scripts/report-registry/README.md`
(schema, conventions, health strip, trust metrics) and the field-guide artifact.

## `/reporting status` — the 60-second check

Run these (all read-only; safe anytime):

```bash
# 1. Trust rollup: expected-vs-landed per week, silent misses, corrective rate (live registry read)
node scripts/report-registry/trust-metrics.mjs            # add --json or --weeks 8

# 2. Drift: is any type's newest genuine row stale/malformed? (exit != 0 = drift)
node scripts/report-registry/check-drift.mjs

# 3. Silent-miss watchdog, report-only (never writes in dry-run)
node scripts/report-registry/watchdog.mjs --dry-run
```

Then, as needed:
- **Registry tail:** newest rows per type are in the check-drift/watchdog output; raw query via
  `ntn datasources query c7d2d9e3-d388-4640-a66e-88f7dd50f854` (TSV, not JSON).
- **Next scheduled runs:** `schtasks /query /tn "<task>"` for the tasks below, or PowerShell
  `Get-ScheduledTaskInfo <task>`.
- **Dated logs:** `~/.claude/logs/<pipeline>/<YYYY-MM-DD>.log` — pipelines: `health-check/`,
  `fourthos-weekly/`, `dashboard-sync/`, `self-improvement/` (project-cards logs to
  `scripts/project-cards/sweep.jsonl`).
- **Hub surfaces:** the Reports hub launcher + Reporting Health strip are machine-owned and
  refreshed by `refresh-pages.mjs` — if they lag the registry, that IS the finding (see heal).

## `/reporting run <pipeline>` — manual invocation

| Pipeline (registry type) | Scheduled task | Manual command |
|---|---|---|
| System Health | `CCv3-Health-Check` (daily 07:50) | `.claude\scripts\scheduled\scheduled-health-check.bat`; output `~/.claude/state/health/latest.json`; Notion mirror skipped (D3) |
| FourthOS Sponsor | `CCv3-FourthOS-Weekly` (Thu 07:00) | `scripts\fourthos-weekly\scheduled-fourthos-weekly.bat` |
| Team Dashboard | `CCv3-Dashboard-Sync` (daily) | `scripts\sync-tasks-dashboard.ps1` (LLM path; deterministic replacement is BLOCKED — see the 2026-07-17 efficiency handoff GAP-1..4) |
| Project Portfolio (cards) | `CCv3-Project-Cards` (daily) | `node scripts/project-cards/sweep.mjs` (`--dry-run` is safe: no publishes, no claude spawn) |
| Self-Improvement | `CCv3-Self-Improvement-Research` (daily 07:30) | headless research loop; digests queue in `docs/self-improvement/PENDING-DIGEST.md` for interactive Bridge sweep |

Every run must land a registry row (make-run + upsert are wired into the wrappers); the upsert
auto-refreshes that type's child page + hub launcher (proposal 02).

## `/reporting heal` — when something is wrong

| Symptom | Action |
|---|---|
| Expected period has no row (missed run) | `node scripts/report-registry/watchdog.mjs` (no flag) writes the visible `watchdog:` miss row; then re-run the pipeline manually and let the genuine row supersede it |
| Hub/child pages lag the registry | `node scripts/report-registry/refresh-pages.mjs` (all) or `--type "<Type>"` (scoped) |
| Health page mirror stale | `node scripts/report-registry/health-mirror.mjs` (`--dry-run` first to preview sections) |
| History gap (rows never emitted) | `node scripts/report-registry/backfill.mjs --dry-run` then without the flag — backfill rows carry the `backfill:` prefix and never masquerade as current |
| Wrapper exits 0 but no artifact | That's the closed 11-week class — check the dated log for `permission-denied` vs `mcp-unavailable` (rule `headless-claude-mcp.md`); fix the grant, never reclassify as SKIP |
| A `.ps1`/`.bat` wrapper change | Test under real PS 5.1 (`powershell.exe -File`), never only pwsh 7; no `Tee-Object -Encoding`; `set` vars ABOVE parenthesized batch blocks |

Conventions that keep this trustworthy (enforced in `make-run.mjs`, proposal 08): corrective rows
carry `backfill:`/`remap:` prefixes; artifact URLs must be durable http(s); one period format per
cadence; every ACTIVE type has a watchdog schedule entry. Retired types (see `retiredTypes` in
`report-runs.ids.json` — VP Weekly, retired 2026-07-25) keep their history and Notion child page
but are excluded from the schedule, drift check and hub table, so they never mint miss-rows.

## Related
- `/log-work` — the row-creation primitive (field parsing, Source detection, dedup).
- `notion-bridge` — the auto-mirror (step 3b) + Eve/Donna handoff queues.
- `weekly-report` — the team dashboard half (Code data + Cowork/Desktop editorial).
- `fourthos-weekly` — the scheduled sponsor site.
- `docs/reporting/reporting-system-overview.md` — full map + "one spine, two cuts" proposal.
- `docs/reporting/donna-reporting-addendum.md` — Donna's parallel rule (Source=Donna).
