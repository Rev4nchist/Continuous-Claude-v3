# Reporting System — Plan / Backlog

The end goal: **"one spine, two cuts"** — the Weekly Work Tracker is the single canonical capture spine;
the team dashboard and sponsor site are two filtered views of it. Steps are ordered cheapest-/highest-
value-first; each lists its gate/dependency. See CURRENT-STATE.md for why each exists.

## Sequenced backlog

### Step 1 — Re-wire the team pipeline (`ai-reporting` MCP) 🟡 IN PROGRESS
The team cut is dead until the MCP can reach Notion.
- [x] Register `ai-reporting` in `~/.mcp.json` (done this session) + import smoke test.
- [ ] **GATE (Dave-only):** create a Notion internal integration → share the Weekly Work Tracker DB
  (`3d7f2afd`) with it → `setx NOTION_TOKEN "ntn_…"` → **restart Claude Code**.
- [ ] Verify: run `/weekly-report`; Phase 1 `collect_weekly_work_tracker` returns Tracker rows.
- *Optional robustness:* add `load_dotenv()` to `ai-reporting-mcp/config.py` so the token can live in its
  gitignored `.env` instead of a machine env var.

### Step 2 — Make the Tracker the canonical spine
- [ ] Confirm `log-work` + the Bridge auto-mirror reliably tag `Source` + `Dashboard Section`.
- [ ] Decide the canonical-row contract (one row per shippable unit; dedup by `Writeback URL`).
- Dependency: none (skill + addendum already define it). This is mostly adoption + a verification pass.

### Step 3 — Close the capture gaps
- [ ] **Code:** adopt the `reporting` skill in practice (log at session-end). ✅ skill exists.
- [ ] **Donna:** place `docs/reporting/donna-reporting-addendum.md` into the Bridge / Donna's system
  prompt so Donna writes `Source=Donna` rows. *(Dave delivers; draft is ready.)*
- [ ] **FourthOS scheduled run:** add a step to `scripts/fourthos-weekly/generate-prompt.md` that logs a
  Tracker row (`Source=Code`, `Dashboard Section=Highlight`) for the week's sponsor work — so it's also
  visible to the team report. Gate: Step 1 token (the run needs Tracker write access via the same token path).

### Step 4 — Two cuts read one spine
- [ ] Team dashboard = full internal cut (unchanged once Step 1 is live).
- [ ] Sponsor site: optionally also read the Tracker for the cross-surface "what shipped" signal, keeping
  the FourthOS Cockpit for portfolio framing. Gate: Steps 1–3.

### Step 5 — (Optional) light enforcement
- [ ] A session-end / Stop hook that nudges (does not block) Code to log unreported shippable work.
  Mirror existing CCv3 hook patterns. Gate: Steps 2–3 proven first (don't enforce a flaky path).

## Immediate next action for the next session
1. Read the handoff + this library.
2. If Dave has set `NOTION_TOKEN` + restarted: verify Step 1 (run `/weekly-report`, confirm Tracker rows),
   then proceed to Step 3 (FourthOS-run-logs-to-Tracker) which is the highest-leverage build remaining.
3. If the token isn't set yet: do Step 3's code (the generate-prompt Tracker-logging step) behind the
   same token gate, and/or the optional `load_dotenv()` robustness — both are unblocked.

## Out of scope (do not bundle here)
- The cma-integration effort (`snapshot/ccv3-system-update`, `feature/cma-integration`).
- The state-of-rework viz deck. Keep this branch reporting-system-only.
