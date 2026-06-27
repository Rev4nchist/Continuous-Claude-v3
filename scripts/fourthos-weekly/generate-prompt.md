# FourthOS Weekly Sponsor Update — Generate Prompt

This prompt is fed to `claude -p` by `scripts/fourthos-weekly/scheduled-fourthos-weekly.bat`
every Friday at 07:00 (and can be run manually the same way). It generates the weekly FourthOS
sponsor update package and stages it UNLISTED for Dave's review.

Read the `fourthos-weekly` skill for the full contract before acting:
`.claude/skills/fourthos-weekly/SKILL.md`.

---

You are a non-interactive `claude -p` session invoked by the Friday 07:00 `CCv3-FourthOS-Weekly`
scheduled task on Windows. Your job: build this week's FourthOS sponsor update package for **Carly**
(VP Enterprise Transformation & Technology) and **Christian** (CTO), stage it to an UNLISTED preview
on the `ai-enablement-decks` GitHub Pages site, and notify Dave to review. **Do not promote it live** —
that is Dave's separate approval step (`promote.mjs`).

## Sources (Notion — via the claude.ai Notion MCP)

- Cockpit: `34076fd7-ac82-805d-ac89-dd26476e2c47`
- Leadership Portfolio Dashboard (5 live DBs): `e29dd1c4-e6a6-4e39-a454-73525a765e5e`
- Update Package saved prompt (the Tier-3 spec to follow verbatim): `82c202b8-2b66-4953-a87d-0177eee58172`
- Connector Ecosystem master plan (flagship for Tier 2): `38776fd7-ac82-81c7-a286-ce6ae478b6be`

## Publish target

- Repo (local): `C:/Users/david.hayes/Projects/ai-enablement-decks` — PUBLIC, auto-deploys on push to `main`.
- Read its `CLAUDE.md` first. Stage into `fourthos/preview/` and **never** add the preview to `decks.json`.
- On promotion (Dave's separate step), `promote.mjs` turns the preview into a dated deck
  `fourthos/<YYYY-MM-DD>/` and adds a card to the **`sponsor-updates`** section (top of the hub,
  newest-first, one row visible + collapse). The generate step only stages preview/.

## Steps

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
<date> › <page>` + tier tabs Hub·Briefing·Deep Dive + data-driven week-switcher) and footer. Brand =
`.claude/skills/fourth-brand-guidelines/` (Fourth Midnight tokens; "iQ"; RAG = colour+label).
**All deck-internal links MUST be root-absolute** `/ai-enablement-decks/fourthos/<date>/…` (NEVER bare
`briefing.html` — trailing-slash-fragile → 404). Add deep-link anchor ids: briefing `#sponsor-actions`,
`#outcomes`, `#risk-radar`; deep-dive `#outputs`, `#concept` (each `scroll-margin-top:80px`).

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
5b. **Write `fourthos/preview/card.json`** — hub-card metadata `promote.mjs` consumes:
   `{ "tag": "Sponsor Update", "title": "FourthOS — <human date>", "description": "<= the headline + biggest move>", "meta": "<human date>", "date": "YYYY-MM-DD" }`.
6. **Stage + push.** From the decks repo: `git add fourthos/preview/`, commit
   `chore(fourthos): weekly preview YYYY-MM-DD`, push to `main`. Do NOT touch `decks.json`.
7. **Verify deploy.** `gh run list --repo Rev4nchist/ai-enablement-decks --limit 3` → expect `success`.
   Confirm `https://rev4nchist.github.io/ai-enablement-decks/fourthos/preview/` loads.
8. **Notify Dave (both channels).**
   - Slack DM via `slack_send_message`: the preview URL + a ≤5-bullet summary of what changed since
     last week + the one-line "to publish: run `node scripts/fourthos-weekly/promote.mjs`".
   - Notion comment on the cockpit's **Sponsor Update Workspace** section: same content.
9. **Final stdout line** (exactly one):
   - success: `fourthos-weekly: OK preview=https://rev4nchist.github.io/ai-enablement-decks/fourthos/preview/ changed=<n>`
   - failure: `fourthos-weekly: FAILED reason=<short>` and exit 1
   - mcp down: `fourthos-weekly: SKIP reason=mcp-unavailable` and exit 0

## Guardrails

- **G1 — Notion unreachable / auth error:** write `fourthos/preview/_ERROR.md` (reason + timestamp),
  push it, send the Slack + Notion "generation FAILED" notice, and print the SKIP line. **Never**
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
