# The FourthOS Reporting System — Overview, Map & Improvement Proposal

*Source of truth for the reporting-system documentation deck. Status as of 2026-06-26.*

How work done across Claude Code, Cowork, and Claude.ai becomes **linked projects in Notion** and is
pulled into the **reporting platform(s)**. Two audiences, one body of work.

---

## 1. The system in one sentence

Work happens on four surfaces → it's **captured into Notion** (the Weekly Work Tracker + the Bridge) →
two reporting outputs **pull from Notion** to produce an **internal team dashboard** and an **external
sponsor briefing**.

## 2. The four stages

### Stage 1 — Work surfaces
| Surface | Role | Owner |
|---|---|---|
| **Claude Code** (CCv3, here) | Execution — builds, fixes, ships | autonomous + Dave |
| **Cowork** | Fourth team work + the report editorial half | Dave + team |
| **Claude.ai — Eve** | Personal strategic layer (ideas, direction) | Dave |
| **Claude.ai — Donna** | Fourth-business strategic layer (SPARK, RFP, MS AI, competitive intel) | Dave |

### Stage 2 — Capture into Notion
| Path | What it does | Automation |
|---|---|---|
| `/log-work` skill | Creates one Weekly Work Tracker row | **MANUAL** (explicit invocation) |
| Bridge **auto-mirror** (notion-bridge step 3b) | Every Code→Eve/Donna writeback also creates a Tracker row | **MANUAL / model-followed — not hook-enforced** |
| Bridge HQ handoff queues + Implementation Log | Eve/Donna/Code coordination + shipped log | **MANUAL** |

### Stage 3 — The Notion data layer
- **Weekly Work Tracker** DB `3d7f2afd` — the reporting **spine**. Fields: `Title` · `Date` · `Type`
  (Ship/Fix/Feature/Integration/Deploy/Decision/Research/Design/Meeting) · `Source`
  (**Code/Donna/Eve/Dave/Team**) · `Impact` (High/Mid/Low) · `Dashboard Section`
  (Deep Dive/Integration/Metric/Adoption/Roadmap/Decision/Highlight/None) · `Project` (relation →
  FourthOS Projects) · `Commits` · `Writeback URL` · `Published in Report` (checkbox).
- **FourthOS Daily Cockpit** `34076fd7` + **Leadership Portfolio Dashboard** `e29dd1c4` (5 live DBs) +
  **Update Package** prompt `82c202b8` + **Connector master plan** `38776fd7`.
- **Bridge HQ** `30e76fd7` — Eve/Donna/Code queues, Key Decisions, Implementation Log, `bridge sync` archive.

### Stage 4 — Reporting outputs (two)
| | **Team dashboard** | **Sponsor site** |
|---|---|---|
| Skill | `/weekly-report` | `fourthos-weekly` |
| Reads | Weekly Work Tracker (via `ai-reporting` MCP `collect_weekly_work_tracker`) | FourthOS Cockpit + Leadership Dashboard (**not** the Tracker) |
| Output | Railway/NeonDB Next.js dashboard | 3 self-contained HTML tiers → GitHub Pages |
| Cadence | **MANUAL**, 2 sessions/wk (Code data half + Cowork/Desktop editorial half) | **SCHEDULED** generate (Fri 07:00 `CCv3-FourthOS-Weekly`) + **MANUAL** promote |
| Audience | AI Enablement **team** (internal) | **Carly + Christian** (VP/CTO) |
| Content bar | Full operational detail | Status-grade only, honesty/badge system |

## 3. The gaps (why it doesn't flow yet)

1. **No shared spine.** The team dashboard reads the Tracker; the sponsor site reads the Cockpit
   instead — and the **scheduled FourthOS run never logs to the Tracker**. The two outputs don't feed
   each other or share an upstream.
2. **Eve & Donna can't reach the Tracker.** `Source = Eve` / `Source = Donna` exist in the schema, but
   neither surface has a path that writes a Tracker row. Their work lands in Bridge queues only.
3. **Capture is manual / un-enforced.** `/log-work` and the Bridge auto-mirror both depend on the model
   remembering to run them; no hook enforces capture. Unreported work is invisible to reporting.
4. **The team-dashboard pipeline is currently broken.** The `ai-reporting` MCP server (which powers
   `collect_weekly_work_tracker`) is **not registered** in `settings.json` / `.mcp.json` — the repo
   exists at `C:/Users/david.hayes/ai-reporting-mcp/` but isn't wired in, so `/weekly-report` Phase 1
   will fail until it's registered.
5. **The collector lives outside the repo.** `tracker_collector.py` / the `ai-reporting` MCP are a
   sibling project (`ai-reporting-mcp/`), not in continuous-claude — easy to lose track of.

## 4. The proposal — "one spine, two cuts"

Keep two distinct **output cuts** (internal team vs VP/CTO sponsor — the audiences and content bar are
intentionally different), but make the **Weekly Work Tracker the single canonical capture spine** that
both cuts draw from. Sequenced, cheapest-first:

1. **Re-wire the team pipeline.** Register the `ai-reporting` MCP (local stdio or Railway HTTP) and
   confirm `/weekly-report` Phase 1 runs. Without this, the team cut is dead. *(External repo action.)*
2. **Make the Tracker the spine.** Every reportable unit of work lands exactly one Tracker row,
   `Source`-tagged, regardless of surface — the one rule the whole system hangs on.
3. **Close the capture gaps:**
   - **Code** → the new `reporting` discipline skill (when/what/how to log; one-spine rule).
   - **Donna** → the Donna addendum (logs her Fourth work as `Source=Donna` rows).
   - **FourthOS scheduled run** → add a step that logs a Tracker row (`Source=Code`,
     `Dashboard Section=Highlight`) so the sponsor work is also visible to the team report.
4. **Two cuts read one spine.** Team dashboard = full internal cut (unchanged). Sponsor site = filtered
   status-grade cut; optionally also read the Tracker for the cross-surface "what shipped" signal while
   keeping the Cockpit for portfolio framing.
5. **(Optional) light enforcement.** A session-end nudge reminding Code to log unreported shippable
   work — a reminder, not a block — mirroring existing CCv3 hook patterns.

**The principle:** capture once, at the moment of work, into one tagged spine; render many cuts from it.
Reporting quality is a *capture* problem, not a *rendering* problem — the renderers are already good.

## 5. How to report (quick reference)

| You are… | When | Do this |
|---|---|---|
| **Claude Code** | After any Ship/Fix/Feature/Integration/Deploy/Decision/Research/Design unit | Log a Tracker row (`Source=Code`) via the `reporting` skill / `/log-work`; on Eve/Donna handoffs the Bridge auto-mirror covers it |
| **Donna** | After significant Fourth-business work or a decision | Write a Tracker row (`Source=Donna`) per the addendum, in addition to the Bridge handoff |
| **Eve** | After a strategic decision worth reporting | (Optional) a Tracker row `Source=Eve`, or rely on the Code writeback auto-mirror |
| **Dave** | Anytime | `/log-work` for anything not auto-captured; `bridge sync` to sweep |

**Field discipline (every row):** `Title` (verb-led) · `Type` · `Impact` · `Date` · `Source` ·
`Dashboard Section` (drives which report section it surfaces in) · `Project` (relation) · `Commits` ·
`Writeback URL` · leave `Published in Report` unchecked (the collector sets it).

---

## Appendix — diagram node/edge model (for the inline SVG + the .excalidraw)

**Layers (color):** work-surface (purple) · capture (sky) · notion (teal) · reporting-output (deep-blue) ·
audience (grey) · infra (muted). **Edge kinds:** AUTO (teal solid) · SCHEDULED (sky solid) ·
MANUAL (amber dashed) · GAP/MISSING (red dashed).

**Current-state nodes:** Claude Code, Cowork, Eve, Donna (surfaces) → /log-work, Bridge auto-mirror,
Bridge HQ (capture) → Weekly Work Tracker [spine], FourthOS Cockpit, Leadership Dashboard (notion) →
Team dashboard (Railway), Sponsor site (GitHub Pages) (outputs) → AI Enablement Team, Carly+Christian (audience).

**Current-state edges:** Code→/log-work (manual); Code→auto-mirror (manual); Code/Eve/Donna→Bridge HQ
(manual); /log-work→Tracker (auto); auto-mirror→Tracker (auto); Tracker→Team dashboard (via ai-reporting
MCP — **GAP: MCP unregistered**); Cockpit+Leadership→Sponsor site (scheduled); Team→Team audience;
Sponsor→Carly+Christian. **GAP edges (red):** Eve→Tracker (missing); Donna→Tracker (missing);
FourthOS run→Tracker (missing).

**Target ("one spine, two cuts") edges:** Code (reporting skill) + Donna (addendum) + Eve + FourthOS run
+ Dave/Team → **Weekly Work Tracker (spine)** → Team cut (full) + Sponsor cut (filtered) → respective
audiences; Cockpit → Sponsor cut (portfolio framing only).
