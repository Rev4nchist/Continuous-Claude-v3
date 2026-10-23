# FourthOS Weekly Sponsor Update — Generate Prompt

This prompt is fed to `claude -p` by `scripts/fourthos-weekly/scheduled-fourthos-weekly.bat`
every Wednesday at 07:00 (moved from Thursday 2026-08-04 — Dave's Carly/Christian meetings are now
Thursday morning, so the package must be reviewed Wednesday; can be run manually the same way). It generates the weekly FourthOS
sponsor update package and stages it UNLISTED for Dave's review.

Read the `fourthos-weekly` skill for the full contract before acting:
`.claude/skills/fourthos-weekly/SKILL.md`.

---

You are a non-interactive `claude -p` session invoked by the Wednesday 07:00 `CCv3-FourthOS-Weekly`
scheduled task on Windows. Your job: build this week's FourthOS sponsor update package for **Carly**
(VP Enterprise Transformation & Technology) and **Christian** (CTO), stage it to an UNLISTED preview
in the `ai-enablement-decks` repo, and notify Dave to review. **Do not promote it live** —
that is Dave's separate approval step (`promote.mjs`).

## Sources (Notion — via the claude.ai Notion MCP)

- Cockpit: `34076fd7-ac82-805d-ac89-dd26476e2c47`
- Leadership Portfolio Dashboard (5 live DBs): `e29dd1c4-e6a6-4e39-a454-73525a765e5e`
- Update Package saved prompt (the Tier-3 spec to follow verbatim): `82c202b8-2b66-4953-a87d-0177eee58172`
- Connector Ecosystem master plan (flagship for Tier 2): `38776fd7-ac82-81c7-a286-ce6ae478b6be`

## Publish target

**THE GITHUB PAGES SITE IS GONE AND IS NOT COMING BACK.** The repo was made private
~2026-08-06, which deletes Pages on the free tier, and it cannot be made public again
(Dave, 2026-08-31). `https://rev4nchist.github.io/ai-enablement-decks/...` has been HTTP 404
ever since. Three consecutive Wednesdays (08-12, 08-19, 08-26) failed on exactly this.

- Repo (local): `~/Projects/ai-enablement-decks` — **PRIVATE**. It is still the
  build store and version history; **git works fine, only Pages is dead.** Push as normal.
- **Do NOT check whether the site is live. Do NOT run `gh run list`. Do NOT curl a
  `github.io` URL.** Deploys fail by design now and are not a failure of your run. Treating a
  dead deploy as your own failure is what produced the last three `_ERROR.md` files.
- Read its `CLAUDE.md` first. Stage into `fourthos/preview/` and **never** add the preview to `decks.json`.
- **Sharing happens outside this run.** After you exit, the wrapper runs
  `scripts/fourthos-weekly/publish-local.mjs`, which rewrites the decks' absolute
  `/ai-enablement-decks/...` links to relative and copies the package into
  `OneDrive - Fourth Limited/FourthOS Sponsor Updates/<date>/` for Dave to share
  Fourth-internally. **You do not do this step and must not attempt it.** Your job ends at a
  committed, pushed `fourthos/preview/`.
- On promotion (Dave's separate step), `promote.mjs` turns the preview into a dated deck
  `fourthos/<YYYY-MM-DD>/` and adds a card to the **`sponsor-updates`** section (top of the hub,
  newest-first, one row visible + collapse). The generate step only stages preview/.

## Steps

0. **Stand-down check — do this FIRST, before any Notion call or any write.** If a preview for
   today already exists, this run must NOT rebuild over it. An interactive generate (Dave building
   the week's package by hand, often the night before) stages exactly the same artifact this task
   would, and regenerating over it would silently replace a reviewed, hand-tuned package with a
   default one. From the decks repo, `~/Projects/ai-enablement-decks`:

   ```
   git -C <decks-repo> fetch origin --quiet
   git -C <decks-repo> log -1 --format=%cs -- fourthos/preview
   ```

   Treat the preview as ALREADY GENERATED when **all** of these hold:
   - that commit date equals today (`YYYY-MM-DD`, local), **and**
   - `fourthos/preview/index.html`, `briefing.html` and `deep-dive.html` all exist, **and**
   - `fourthos/preview/_ERROR.md` does **not** exist.

   If already generated: make **no** Notion writes, **no** git writes and **no** Slack message.
   Print exactly `fourthos-weekly: SKIP reason=already-generated-today` and exit 0. This is a
   deliberate no-publish condition, which is what the SKIP sentinel is for — the wrapper still
   records a registry row, so the always-emit spine is preserved and the week reads as
   "deliberately skipped" rather than "never ran". Do not disguise it as a failure, and do not
   delete or overwrite the existing preview.

   If `_ERROR.md` IS present, that is a prior failed run, **not** an already-generated preview —
   continue with a normal generate (step 6 deletes the stale `_ERROR.md`).

1. **Pre-flight.** Confirm the Notion MCP is reachable (`notion-fetch` the cockpit). If it fails or
   returns an auth error, follow Guardrail G1 and stop.
2. **Refresh the Tier 3 package.** Following the saved-prompt structure (page `82c202b8…`) exactly,
   create/update the Notion child page **"FourthOS Update Package — YYYY-MM-DD"** under the cockpit.
   Pull from Portfolio Live Look, Sponsor Action Required, Risk Radar, Sponsor-Ready Outputs, and
   Outcome Evidence Stream. Do not invent status or outputs. If a DB is empty, say so in §10 of the
   package. This page (incl. its §9 JSON data model) is the source of truth for the HTML tiers.
   The data model MUST include these fields (added v2):
   - `headline` — the week's single biggest news, ≤10 words (becomes the hub H1; NOT "Weekly Sponsor Update").
   - `subheadline` — one supporting sentence (the hero subhead).
   - `shipped[]` — `{ label, anchor }` recently-shipped items; `anchor` is an in-site target such as
     `deep-dive.html#outputs` or `briefing.html#outcomes`.

### Design system (apply to ALL three tiers)
Use the shared shell `.claude/skills/fourthos-weekly/templates/shell.html` (read its README) for the
**chrome on every page**: custom FourthOS SVG mark, sticky **top bar** (breadcrumb `Sponsor Updates ›
<date> › <page>` + tier tabs Hub·Briefing·Deep Dive **with hover section menus** (`.tab-wrap`/`.tab-menu`
— each tab reveals that page's sections; keep menu anchors in sync with rendered ids) + data-driven
week-switcher) and footer. Brand = `.claude/skills/fourth-brand-guidelines/` (Fourth Midnight tokens;
"iQ"; RAG = colour+label).
**All deck-internal links MUST be root-absolute** `/ai-enablement-decks/fourthos/<date>/…` (NEVER bare
`briefing.html` — trailing-slash-fragile → 404). Add deep-link anchor ids: briefing `#sponsor-actions`,
`#portfolio`, `#outcomes`, `#risk-radar`, `#action-0N`; deep-dive `#thesis`, `#outputs`, `#concept`,
`#reporting`, `#feedback`, `#payoff`; hub `#glance`, `#next`, `#seeds`, `#pillars` (each
`scroll-margin-top:80px`).

**Layout rules (Dave, 2026-07-02):**
- Briefing "Portfolio Pulse": NO tall-narrow stat cards. The 4 short facts render as WIDE horizontal
  label/value rows (2 per row on desktop); "What changed this week" is a full-width strip with one
  ✓-bullet per discrete change. The "Biggest decision" tile names exactly ONE decision.
- Sponsor actions render as DECISION cards under the heading "For Your Decision": h3 = the decision as
  a verb phrase, then rows Recommendation → Decide by → Cost of waiting → (detail) → Owner. FYI/endorse
  items use the dashed `.action-card.fyi` variant. Cards carry `id="action-0N"`; hub "Needs you" items
  and project-card decision flags link to the specific card.
- Hub body: sponsor-lens glance FIRST, nav cards second. Chip row label is "This week".

**Clarity Contract (MANDATORY — the #1 rule; read the skill's "Clarity Contract" section in full).**
Carly and Christian are NOT inside the projects — write every unit so a smart non-technical leader
understands it cold, in one pass. Clarity beats completeness.
- **Change → Benefit (every progress item, each portfolio card's focus / latest update / next milestone,
  every outcome, risk, and sponsor action):** state (1) *what concretely changed* this week — never
  "worked on" / "progressed" / "continued" — and (2) *the benefit and the named beneficiary* (the
  company, a specific team like CS or RevOps, end users, a customer, or the sponsors' own decision),
  linked with "so that" / "which means". If you cannot name a benefit AND a beneficiary, it is activity,
  not progress — dig for the real outcome or cut it.
- **Outcome first, mechanism second. One idea per sentence. Halve any sentence you can.**
- Climb the **So-What Ladder**: Raw (version/test/bug — never shown) → Capability (plain verb) → Value
  (Trust / Usefulness / Risk retired / Readiness / Speed) → Sponsor sentence (≤25 words, one evidence
  anchor, honesty badge, names the beneficiary). Match the before→after calibration table in the skill.

**Language mechanics (MANDATORY — see the skill's "Language rules" table for full replacements):**
BANNED: "topology". Technical terms are defined on first use or replaced with plain phrasing
(SWA → "access-gated report site"; Entra groups → "per-audience security groups"; OBO → "each person
signs in as themselves"; ADR → "architecture decision record"; drop rev numbers from Tier 1). Claim
calibration: adversarial test results are "demonstrated"/"held 16/16", never "proven"/"secure".

**Honesty / 3-state badge system (MANDATORY — never overstate to a VP/CTO).** Tag every capability:
**LIVE** (running in prod now — teal filled) · **BUILT IN-REPO** (code-complete/proven, not yet
hosted/wired — sky outline) · **DESIGNED · NEXT** (designed, not built — dashed muted). Rules: only
things actually running carry LIVE; the Salesforce connector is **"live in ALPHA"** (released for alpha
testing, NOT GA — never write "live in production"); reporting hosted distribution + the feedback
auto-alert are DESIGNED·NEXT (the report *engine* + feedback capture/store/pull are BUILT IN-REPO).
**Never publish real person names** (use HMAC pseudonyms / counts). The published HTML is grep-audited
for these rules. Reusable patterns proven in `fourthos/2026-06-24/`: badge component, the interactive
"same data, three governed views" tier-toggle, the inheritance ("this becomes every connector") diagram.

3. **Render Tier 1 — `fourthos/preview/briefing.html`.** Shell chrome + a dashboard: Portfolio Live
   Look cards, **Sponsor Action Required** (`#sponsor-actions`), **Risk Radar** (`#risk-radar`), and
   **Outcomes/Evidence** (`#outcomes`). Status-grade only. Tier pager (← Hub · Deep Dive →) at foot.
4. **Render Tier 2 — `fourthos/preview/deep-dive.html`.** Shell chrome + scrollytelling teaching site
   for the flagship: **Concept Spotlight** (`#concept`, rotate weekly), inline architecture SVG, and
   **Outputs** (`#outputs`). Tier pager (← The Briefing · Back to Hub →) at foot.
5. **Render the hub — `fourthos/preview/index.html`.** Shell chrome + a **headline hero**: eyebrow
   "Weekly Sponsor Update · <date>", H1 = `headline`, subhead = `subheadline`, a primary CTA
   "See what needs you →" → `briefing.html#sponsor-actions`, and a **Recently shipped** chip row from
   `shipped[]` (each chip deep-links to its `anchor`). NO RAG/health pill on the hub. Then the two
   nav cards and the **sponsor-lens glance**: **Needs you** (sponsorActions → `briefing.html#sponsor-actions`)
   / **What moved** (`shipped[]` → anchors) / **Watch** (risks → `briefing.html#risk-radar`).
5a. **Render the Mandate Pillars section — `id="pillars"`, after `#seeds` on the hub (MANDATORY,
   see the skill's "Mandate Pillars section" for the full spec).** Reuse the CSS + markup pattern
   from `fourthos/2026-07-09/index.html` (`.pillars-sec`/`.balance`/`.pillar-grid`/`.pillar-card`/
   `.rag-pip`). For each of the 3 official mandate pillars (Research & Strategic Intelligence /
   Prototyping & POC Development / External Developer Experience Portal): pull the mandate's own
   one-line pillar definition from the cockpit page (`34076fd7…`), pick 2–4 active projects whose
   clearest-home pillar this is (judgment call from each project's `Pillars` tags — do not duplicate
   a project across two cards), and write one sentence of *why* per project. Compute the balance-strip
   counts (active initiatives per pillar this week) and write one honest sentence about any imbalance
   — a `0` in Portal-direct is sequencing, not failure, IF the connector-ecosystem/governance work is
   active; use the empty-state + "directly transferable" pattern (`.pc-empty`/`.pc-indirect`) on
   Pillar 3 in that case rather than a bare "nothing here." Add the `#pillars` anchor to the hub's
   tab-menu ("How this connects").
5b. **Write `fourthos/preview/card.json`** — hub-card metadata `promote.mjs` consumes:
   `{ "tag": "Sponsor Update", "title": "FourthOS — <human date>", "description": "<= the headline + biggest move>", "meta": "<human date>", "date": "YYYY-MM-DD" }`.
6. **Stage + push.** From the decks repo: if a stale `fourthos/preview/_ERROR.md` exists from a
   prior failed week, DELETE it as part of this staging (a successful run must not leave it behind).
   Then `git add fourthos/preview/`, commit `chore(fourthos): weekly preview YYYY-MM-DD`, push to
   `main`. Do NOT touch `decks.json`.
7. **Verify the COMMIT, not a deploy.** `git -C <decks-repo> status --porcelain -- fourthos/preview`
   must be empty (everything committed) and `git -C <decks-repo> log -1 --format=%cs -- fourthos/preview`
   must be today. That is the whole check. **There is no deploy to verify** — see "Publish target".
8. **Notify Dave (both channels).**
   - Slack DM via `slack_send_message`: a ≤5-bullet summary of what changed since last week, plus
     "the package will be in `OneDrive - Fourth Limited/FourthOS Sponsor Updates/<today>/` once the
     wrapper publishes it" and the one-line "to promote: run `node scripts/fourthos-weekly/promote.mjs`".
     **Do not include a `github.io` URL** — it is a dead link.
   - Notion comment on the cockpit's **Sponsor Update Workspace** section: same content.
9. **Final stdout line** (exactly one):
   - success: `fourthos-weekly: OK staged=fourthos/preview changed=<n>`
   - failure (INCLUDING Notion unreachable / auth error — see G1): `fourthos-weekly: FAILED reason=<short>`
     (note: a model inside `claude -p` cannot set the process exit code — the FAILED **sentinel line**
     plus `_ERROR.md` are the real failure signals; the wrapper's verify step turns them into a
     Failed registry row and a nonzero Task Scheduler result)
   - deliberate no-publish (a valid "nothing to publish this week" condition ONLY — never an error path):
     `fourthos-weekly: SKIP reason=<short>` and exit 0

   Note: the scheduled wrapper independently verifies the staged artifact in the decks repo
   after this run (`scripts/fourthos-weekly/verify-run.mjs`) and records `Failed reason=no-artifact`
   in the Report Runs registry if no fresh committed `fourthos/preview/` exists — regardless of
   what this line claims. The sentinel is corroborating evidence, not the source of truth.

## Guardrails

- **G1 — Notion unreachable / auth error:** this IS a failure (it writes _ERROR.md and sends FAILED
  notices — do not disguise it as a skip). Write `fourthos/preview/_ERROR.md` (reason + timestamp),
  push it, send the Slack + Notion "generation FAILED" notice, and print
  `fourthos-weekly: FAILED reason=notion-unreachable` as the final line (the wrapper's verify step
  converts the sentinel + `_ERROR.md` into a Failed registry row and a nonzero task result). **Never**
  overwrite the stable `fourthos/` artifacts. The Notion package remains the source of truth.
- **G2 — Empty/missing Projects data:** treat as failure, not as "nothing to report". Do not publish
  an empty dashboard over good content.
- **G3 — Public surface:** published Tiers 1–2 carry status-grade content only. Never render sensitive
  risk/decision detail into HTML; that stays in the Notion Tier-3 archive.
- **G4 — Manifest safety:** this generate step must NOT modify `decks.json` (that is `promote.mjs`'s job).
- **G5 — No subagents.** Single-session. Time budget ~6 min; if any single MCP call exceeds 60s, bail
  with a clear status line.
- **G6 — Diagrams:** never start the Excalidraw canvas server in this headless run; only embed the
  already-committed SVG.
