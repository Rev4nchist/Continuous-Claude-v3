# Reporting System — Orientation Library

> Start here. This library gives a new session full context to continue the **Reporting System**
> effort toward one detailed, accurate end goal — with zero context loss.

Read order: **README** (this, the why + rules) → **CURRENT-STATE.md** (what exists) →
**PLAN.md** (what's next, in order) → **RESOURCE-MAP.md** (where everything lives).
Then read the session handoff: `docs/HANDOFF-2026-06-27-reporting-system.md`.

---

## What the reporting system is

How work done across **Claude Code, Cowork, and Claude.ai (Eve + Donna)** becomes **linked records in
Notion** and is pulled into **two reporting outputs**: an internal **team dashboard** and an external
**sponsor briefing**. Two audiences, one body of work.

Full prose map + the improvement proposal live in `docs/reporting/reporting-system-overview.md`
(the canonical source) and are published as a live doc deck (see RESOURCE-MAP).

## The end goal — the "one spine" rule

> **Every reportable unit of work → exactly one Weekly Work Tracker row, `Source`-tagged.**
> Capture once, at the moment of work, into one tagged spine; render many cuts from it.

The **AI Enablement Weekly Work Tracker** (Notion DB `3d7f2afd`) is the spine. Every row carries
`Title · Date · Type · Source (Code/Donna/Eve/Dave/Team) · Impact · Dashboard Section · Project
(relation) · Commits · Writeback URL · Published in Report`. Reporting quality is a **capture**
problem, not a rendering problem — the renderers are already good.

## How the pieces interlock

```
WORK SURFACES        CAPTURE → NOTION                 SPINE                  TWO CUTS
Claude Code  ─ /log-work (manual) ─────────────►  Weekly Work Tracker ─► Team dashboard (Railway)
Cowork       ─ Bridge auto-mirror (step 3b) ────►   (3d7f2afd)         └► Sponsor site (GitHub Pages)
Eve/Donna    ─ Bridge HQ queues (manual) ───────►        ▲
                                                  FourthOS Cockpit (sponsor portfolio framing)
```

- **`reporting` skill** (`.claude/skills/reporting/`) — the Code discipline: WHEN/WHAT/HOW Code logs.
  Orchestrates the primitives below; enforces the one-spine rule.
- **`log-work` skill** — the primitive that writes a single Tracker row.
- **`notion-bridge` skill** — Eve/Donna/Code handoff queues + the **auto-mirror** (a Code→Eve/Donna
  writeback also creates a Tracker row). Model-followed, not hook-enforced.
- **`weekly-report` skill** — the **team cut**: `ai-reporting` MCP `collect_weekly_work_tracker` reads
  the Tracker → Railway/NeonDB dashboard. Code pushes data half; Cowork/Desktop adds editorial + publishes.
- **`fourthos-weekly` skill** — the **sponsor cut**: scheduled `claude -p` reads the FourthOS Cockpit +
  Leadership Dashboard → 3 HTML tiers → GitHub Pages. (Today it does NOT read the Tracker — see PLAN.)
- **Donna addendum** (`docs/reporting/donna-reporting-addendum.md`) — how Donna logs `Source=Donna` rows.

## How the multi-session work coordinates

- **One end goal, many sessions.** Each session opens the handoff, reads this library, advances PLAN.md,
  then updates the handoff + ROADMAP + this library before ending.
- **Snapshot branches per effort.** This effort lives on **`snapshot/reporting-system`** (off `main`,
  pushed to `fork`). A parallel CCv3 effort lives on `snapshot/ccv3-system-update` — keep them isolated;
  do not co-mingle commits.
- **The Tracker + Bridge HQ are the shared live state** across sessions and across the Eve/Donna/Code
  instances — they are how parallel work stays coherent.

## Rules of engagement + hard constraints

- **Push `fork` (Rev4nchist), NEVER `origin`** (parcadei is upstream).
- **Keep this branch isolated** — only reporting-system work; never bundle cma/viz/other in-progress work.
- **Windows-safe commands.** Prefer PowerShell for `git` (the bash shell init can stall); paths need a
  drive letter; `python` not `python3`; never Edit `.claude.json`/settings via the Edit tool.
- **Accuracy over optimism.** Never claim a hop is automated/live when it isn't (e.g. the `ai-reporting`
  MCP is *registered but pending a `NOTION_TOKEN`*; the FourthOS run does *not* yet log to the Tracker).
- **Sponsor-facing artifacts are PUBLIC GitHub Pages** — status-grade content only; no real PII / names
  (use HMAC pseudonyms / counts); honesty badges LIVE·ALPHA / BUILT IN-REPO / DESIGNED·NEXT.
- **Capture once.** When you ship something here, log it to the Tracker (that's the whole point).
