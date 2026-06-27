---
name: reporting
description: The Code reporting discipline — when, what, and how Claude Code records work so it flows into the weekly reports. Defines the "one spine" rule (every reportable unit of work lands one Weekly Work Tracker row, Source-tagged), the field mapping, the Bridge writeback/auto-mirror tie-in, and how capture feeds the team dashboard + sponsor site. Use when finishing a unit of work worth reporting, when asked "how should I report this", "log this for the report", "report discipline", or at the end of a session to capture unreported work. Orchestrates the /log-work primitive and the notion-bridge auto-mirror; does not replace them.
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

## Related
- `/log-work` — the row-creation primitive (field parsing, Source detection, dedup).
- `notion-bridge` — the auto-mirror (step 3b) + Eve/Donna handoff queues.
- `weekly-report` — the team dashboard half (Code data + Cowork/Desktop editorial).
- `fourthos-weekly` — the scheduled sponsor site.
- `docs/reporting/reporting-system-overview.md` — full map + "one spine, two cuts" proposal.
- `docs/reporting/donna-reporting-addendum.md` — Donna's parallel rule (Source=Donna).
