# Day-1 Platform Gate — Claude for Sales SKO

**Build step 1 of `01-PACKAGE-DESIGN.md`.** This is a *gate*: nothing downstream (skills, kit, course) gets finalized until the three platform capabilities below are confirmed in **Fourth's Sales Claude Enterprise workspace** and the pilot-license request is in motion. It is the first verification, not the last (design doc §Verification).

Owner: **David Hayes** (workspace checks) + **Sarah Kirkland / Jay** (license request). Target: resolve all rows **by day 3** so the fallback decision (Salesforce demoted to facilitator-demo) can be made with time to re-plan.

Status legend: ⬜ not started · 🟡 in progress · ✅ pass · ❌ fail (triggers fallback)

---

## Gate A — App Skills are publishable + rep-installable

The whole `#4 installable skills` deliverable depends on reps being able to *install* `account-research` (and Enterprise reps `account-planner`) as real capability, not paste-text. Verify the actual mechanism available in Fourth's org.

| # | Check | How to verify | Result | Notes |
|---|---|---|---|---|
| A1 | Custom Skills are enabled for the workspace | Admin console → check Skills / capabilities is on for the Enterprise plan | ⬜ | |
| A2 | A skill can be **authored + uploaded** by an admin | Upload a throwaway `SKILL.md` (e.g. a 3-line "hello sales" skill) via the create-custom-skill flow | ⬜ | Ref: support.claude.com "How to Create Custom Skills" |
| A3 | A published skill is **installable by a rep** (self-serve) OR **admin-pushable** org-wide | On a rep-tier test account, confirm the test skill appears + installs; if not self-serve, find the admin-push/allowlist path | ⬜ | Determines whether SKO setup-block has reps self-install or IT pre-installs |
| A4 | Skill install survives on **mobile** | Confirm the installed test skill is usable in the Claude mobile app (the "it's on your phone tonight" promise) | ⬜ | |

**Decision from Gate A:** install mechanism = ☐ rep self-serve ☐ admin-push/allowlist ☐ blocked.
→ Feeds the Setup Block script (run-of-show) and the facilitator cheat sheet.

---

## Gate B — Built-in web search is enabled

`account-research` is re-based onto **built-in web search** (locked decision #4 — fourth-playwright is out of rep hands). If web search is admin-disabled for the workspace, the entire beginner tier + the Enterprise research prompt break.

| # | Check | How to verify | Result | Notes |
|---|---|---|---|---|
| B1 | Web search is on for the Enterprise workspace | In a rep-tier test chat, ask a question requiring a live web lookup; confirm it searches + cites | ⬜ | |
| B2 | Web search returns **clickable sources** | Confirm citations render as links (the competition quality gate requires clickable-source traceability) | ⬜ | |
| B3 | Per-user $50/mo limit doesn't choke research | Confirm a ~5-prompt research sequence stays within budget for a normal rep | ⬜ | Source review: limit raised $10→$50 for real work |

**If B1 = ❌:** escalate to admin to enable before SKO; there is no rep-side fallback for web search.

---

## Gate C — Salesforce connector object scope

Salesforce is the **primary Enterprise data path**, conditional on this gate (locked decision #2). Research confirmed the connector is session-bound, respects sharing rules, and needs admin OAuth setup — but the **object-level default scope is UNVERIFIED against Fourth's org** (external-best-practices.md §2, INFERRED). Confirm what a rep actually pulls.

| # | Check | How to verify | Result | Notes |
|---|---|---|---|---|
| C1 | Connector is provisioned + authenticates for a rep | On a rep-tier test account, authenticate the Salesforce connector; confirm "your opportunities appear" | ⬜ | This is the on-screen success check in the Setup Block |
| C2 | **Accounts** readable | Ask Claude to pull a known account's summary | ⬜ | |
| C3 | **Opportunities / pipeline** readable | Pull open opps for that account | ⬜ | Core to the account snapshot (breakout prompt 2) |
| C4 | **Contacts** readable | Pull contacts for that account | ⬜ | Feeds buying-committee mapping |
| C5 | **Activities / Tasks** readable (default or needs perm-set grant?) | Pull recent activity history; note if empty vs. present | ⬜ | The specific INFERRED gap — Activities/OLI may need explicit grants |
| C6 | Sparse-data behavior confirmed | Have a rep query an account **outside their territory**; confirm it returns empty/incomplete (not an error) | ⬜ | Validates the "if data looks sparse, check your access" callout |

**Decision from Gate C:** which objects are in-scope by default = ______________________.
→ Determines the account-context template fields, the SF runbook, and whether the qualification-translation prompt can rely on activity data.

---

## Gate D — Pilot licenses (resolves the licenses-at-SKO contradiction, Retired #1/#5)

Licenses land AT SKO by design (source review), but the pilot ladder (build step 7) needs **5 named licenses before the event**. Request them now.

| # | Action | Owner | Result | Notes |
|---|---|---|---|---|
| D1 | Request **5 named pilot licenses** (full Enterprise, $50/mo, SF connector) provisioned this week | Sarah → Jay | ⬜ | Draft: `03-PILOT-LICENSE-REQUEST.md` |
| D2 | Confirm the 5 pilots include ≥1 Enterprise rep with real SF pipeline | Dave + Sarah | ⬜ | Needed to test the full SF path, not just beginner tier |
| D3 | Sync with Sarah on **run-of-show ownership** + shared editing | Dave ↔ Sarah | ⬜ | Sarah owns training; run-of-show is a shared doc |
| D4 | Get the **Sales survey results** (drives taught use cases) | Sarah | ⬜ | Still pending per source review |

**Fallback (decide by day 3):** if pilot licenses are **refused** → Salesforce demotes to **facilitator-demo only**; hand-filled account context becomes the primary Enterprise data path; the SF runbook and breakout prompt 2 are re-scoped accordingly. Record the decision here:

> Pilot-license decision (date / outcome): ________________________________

---

## Gate summary → downstream unblock

| Gate | Result | Blocks if ❌ |
|---|---|---|
| A — skills installable | ⬜ | Entire `#4` deliverable; setup-block install step |
| B — web search on | ⬜ | Beginner tier + Enterprise research prompt |
| C — SF object scope | ⬜ | Enterprise SF path (→ fallback to hand-filled context) |
| D — pilot licenses | ⬜ | Pilot ladder (step 7); SF-at-SKO commitment |

**Proceed to build step 2 (`account-research/SKILL.md`) once B is ✅** — the research skill only depends on web search, so authoring can start in parallel with A/C/D resolution. Do not finalize the Enterprise kit (step 4) or SF runbook until C + D resolve.
