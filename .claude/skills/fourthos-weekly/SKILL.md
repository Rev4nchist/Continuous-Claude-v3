---
name: fourthos-weekly
description: Generates and stages the weekly FourthOS sponsor update (Carly/Christian) from Notion data. Use when asked to generate, build, preview, or promote the FourthOS weekly sponsor update, or when the scheduled task runs.
disable-model-invocation: true
---

# FourthOS Weekly Sponsor Update Pipeline

Operationalizes the existing Notion "Update Package Generator" intent into a scheduled,
multi-tier, **draft-and-notify** artifact pipeline for sponsors **Carly** (VP Enterprise
Transformation & Technology) and **Christian** (CTO, dotted line).

**Mental model:** Dave stays editor-in-chief. The pipeline auto-builds everything to an
*unlisted* preview each Wednesday morning and pings Dave (Dave's Carly/Christian meetings
moved to Thursday MORNING as of 2026-08-04, so review happens Wednesday); nothing reaches
sponsors until Dave promotes it. The "teach what we build/research" mandate is carried by the Tier 2 **Concept
Spotlight** module.

---

## The two commands

| Intent | What runs | Who triggers |
|---|---|---|
| **Generate** (default) | Read Notion → refresh Tier 3 package → render Tier 1+2 → stage to `fourthos/preview/` (unlisted) → notify Dave | `CCv3-FourthOS-Weekly` task (**Wed 07:00** — moved from Thu 2026-08-04 because the sponsor meetings are now Thursday morning; previously moved from Fri 2026-07-02) OR Dave interactively |
| **Promote** | `fourthos/preview/` → dated `fourthos/<YYYY-MM-DD>/` + add its card to `decks.json` `sponsor-updates` (newest becomes `featured`, prior weeks demoted) → push | Dave, after reviewing the preview |

- **Generate** headless path (unattended, Wednesday 07:00): `scripts/fourthos-weekly/scheduled-fourthos-weekly.bat`
  pipes `scripts/fourthos-weekly/generate-prompt.md` into `claude -p`.
- **Promote**: `node scripts/fourthos-weekly/promote.mjs` (run from anywhere; it targets the decks repo).
  Options: `--date=YYYY-MM-DD`, `--dry-run`, `--no-push`.

### Interactive companion (this skill IS the pairing skill)

The scheduled task and this skill are two faces of the same pipeline. When invoked interactively
(`/fourthos-weekly`, "generate the fourthos update", "review the sponsor preview", "promote it"):
- **Generate now** — execute the `generate-prompt.md` steps directly using the session's Notion / git /
  Slack tools (cleaner than spawning a nested `claude -p`); stage to `fourthos/preview/` + `card.json`.
- **Review** — open/probe the preview URLs and spot-check brand + content before promotion.
- **Promote** — run `promote.mjs` to publish the dated card once Dave approves.
This is the human-in-the-loop path; the `.bat` is the same flow on a timer.

---

## Data sources (Notion — read via the claude.ai Notion MCP)

| Source | ID / URL |
|---|---|
| FourthOS Daily Cockpit (control plane; also titled "FourthOS - Principal AI Mandate" — the 3-pillar mandate text lives on this same page, used by the Mandate Pillars section below) | `34076fd7-ac82-805d-ac89-dd26476e2c47` |
| Leadership Portfolio Dashboard (5 live DBs) | `e29dd1c4-e6a6-4e39-a454-73525a765e5e` |
| Update Package Generator — Saved Prompt (the Tier-3 spec) | `82c202b8-2b66-4953-a87d-0177eee58172` |
| Connector Ecosystem — Master Plan (flagship for Tier 2) | `38776fd7-ac82-81c7-a286-ce6ae478b6be` |

The Tier-3 **Update Package** is the structured source of truth (incl. a JSON data model in §9).
Tiers 1 and 2 are rendered **from that package** — never invent status/outputs not present in it.

**Headless Notion-MCP is UNRELIABLE — do not assume it "just works."** The claude.ai Notion
connector *does* load headless and its OAuth is valid (verified 2026-07-16), BUT non-interactive
`claude -p` **auto-denies** any MCP tool that is not explicitly granted (via `--allowedTools` or a
settings allow-list) — there is no interactive prompt to approve it. An un-granted call surfaces to
the prompt as a permission error, which the guardrails record as `SKIP reason=mcp-unavailable` and
exit 0. This is why the `CCv3-Health-Check` Notion mirror was **silently frozen for ~11 weeks** — the
earlier "reachability is proven" claim was FALSE. Consequences for this pipeline: trust the outcome
from `verify-run.mjs` (artifact truth), never from the model's self-reported status line; and prefer
the **`ntn` CLI** for deterministic Notion steps (every `ntn` step succeeds headless), reserving the
LLM+MCP path for genuinely generative work that must also carry a `--allowedTools` grant.

---

## Portfolio structure — TWO projects (as of 2026-06-30)

The connector work is tracked as **two distinct projects** in the FourthOS Projects DB
(`852a60e1`), each with its own dependency/task/development streams. The report must treat
them separately — this is what makes velocity / stall-watch meaningful (you need >1 project):

- **Salesforce Connector** (the *product*; this repo `salesforce-fastmcp`) — connector
  correctness/UX, security hardening, pilot onboarding + feedback, schema coverage.
  Currently **Green · live in ALPHA** (ACA rev 0000020).
- **Connector Ecosystem** (the *program*) — framework/template extraction, reporting
  distribution (gated SWA + ACA Job), Zendesk connector #2 green-light, composability,
  dev-portal surface. Currently **Yellow** (reporting blocked on IT/Danny for Entra groups).

The Tier-2 flagship deep-dive rotates between them; the Salesforce Connector is the natural
flagship while it is the live proof point. Fail-loud guard #2 (empty-DB = failure) now
expects **≥2 active projects**.

---

## Progressive-disclosure ladder (v1 = Tiers 1, 2, 3)

| Tier | Artifact | Built with |
|---|---|---|
| **0 — Pulse** (hero of Tier 1) | RAG status · flagship · biggest decision · biggest risk · next proof point · "what changed" | html-engine hero block |
| **1 — Briefing** | Interactive dashboard: Portfolio Live Look cards + Sponsor Action Required + Risk Radar + Outcomes/Evidence | `.claude/skills/fourth-presentation-suite/html-engine/` + brand tokens |
| **2 — Deep Dive** | Scrollytelling teaching site for the flagship + **Concept Spotlight** explainer + Excalidraw architecture SVG | `.claude/skills/frontend-slides/` + committed SVG |
| **3 — Archive** | Notion "FourthOS Update Package — YYYY-MM-DD" child page (structured, incl. JSON data model) | Notion MCP write, per saved prompt `82c202b8…` |

**Content bar (load-bearing):** Published Tiers 1–2 are **status-grade only** (RAG, current focus,
milestones, outcomes) — the same public bar as the existing `governed-ai-access` VP briefing.
Genuinely sensitive risk/decision detail lives ONLY in the Notion Tier-3 archive and is never
rendered into the published HTML. **GitHub Pages is public; the preview slug is unlisted, not private.**

---

## Site chrome & navigation (v2 — shared shell; hover ToC added 2026-07-02)

Every tier uses the shared shell `templates/shell.html` (+ `templates/README.md`): custom inline-SVG
FourthOS mark, a sticky **top bar** (breadcrumb `Sponsor Updates › <date> › <page>` + tier tabs
Hub·Briefing·Deep-Dive + a data-driven **week-switcher** that reads `decks.json`), and a shared footer.
- **Hover section nav (tab ToC — MANDATORY since 2026-07-02):** each top-bar tab reveals a hover
  dropdown listing that page's sections (quick nav + table of contents). Markup/CSS live in
  `templates/shell.html` (`.tab-wrap` / `.tab-menu`). Keep menu anchors in sync with the section ids
  actually rendered that week; every target id needs `scroll-margin-top:80px`. Menus are hidden ≤720px.
- **Hub hero is headline-driven:** H1 = the week's biggest news (`headline`), not "Weekly Sponsor
  Update"; supporting `subheadline`; a **"This week"** chip row (`shipped[]` — label the row "This
  week", not "Recently shipped", so discovery/decision items sit under it honestly); **no RAG/health
  pill** (health lives on the Briefing's portfolio cards). Hub body order: sponsor-lens glance
  (**Needs you / What moved / Watch**) FIRST, nav cards second — decisions outrank navigation chrome.
- **Briefing "Portfolio Pulse" hero layout:** never tall-narrow stat cards. The 4 short facts
  (Flagship / Biggest decision / Biggest risk / Next proof point) render as WIDE horizontal
  label-left/value-right rows, two per row on desktop; **"What changed this week"** is a full-width
  strip with one ✓-bullet per discrete change (not a semicolon chain). The "Biggest decision" tile
  names exactly ONE decision.
- **Sponsor actions are decision cards ("For Your Decision"):** every card follows the skeleton
  h3 = the decision as a verb phrase → **Recommendation → Decide by → Cost of waiting → (detail) →
  Owner**. FYI/endorse items use the dashed `.action-card.fyi` variant and say what happens if no
  response comes. Cards carry `id="action-01/-02/-03"`; hub "Needs you" items and project-card
  decision flags link to the specific card id.
- **Links are root-absolute** (`/ai-enablement-decks/fourthos/<date>/…`) — bare relative links 404 on
  Pages without a trailing slash. Deep-link anchors: briefing `#sponsor-actions`/`#portfolio`/
  `#outcomes`/`#risk-radar`/`#action-0N`, deep-dive `#thesis`/`#outputs`/`#concept`/`#architecture`/
  `#reporting`/`#feedback`/`#payoff`, hub `#glance`/`#next`/`#seeds`/`#pillars`.

## Mandate Pillars section (hub — MANDATORY, added 2026-07-09)

The hub gets a fourth section, **"How This Connects"** (`id="pillars"`, `.pillars-sec`), placed
**after `#seeds` ("What this seeds")** — reflective/strategic content, so it never competes with the
decision-first flow above it. It maps the week's active portfolio to the 3 *official* FourthOS
mandate pillars — **AI Research & Strategic Intelligence**, **Prototyping & POC Development**,
**External Developer Experience Portal** — sourced from the mandate text on the cockpit page
(`34076fd7…`, see Data sources above). Reference implementation: `fourthos/2026-07-09/index.html`
(`.pillars-sec`/`.balance`/`.pillar-grid`/`.pillar-card`/`.rag-pip` CSS — copy these classes into
each new week's hub `<style>` block; they're additive to the existing token set, no new `:root`
variables needed).

Structure, every week:
- **Sec-dek + source line**: one sentence framing ("The role is built on three pillars of equal
  strategic weight..."), then `Source: <a href="https://app.notion.com/p/34076fd7ac82805dac89dd26476e2c47">FourthOS — Principal AI Mandate</a>, Carly's formal role proposal.`
- **Balance strip** (`.balance`) — the section's actual finding, not decoration: a count of active
  initiatives per pillar this week (Research / Prototyping / Portal-direct) + a segmented bar + one
  honest sentence explaining any imbalance. A `0` in Portal-direct is common and NOT itself bad news —
  frame it per the sequencing logic below, never as a bare deficiency stat.
- **Three pillar cards** (`.pillar-grid` → `.pillar-card` ×3), each: the mandate's own one-line
  definition of that pillar (`.pc-mandate`, italic, quoted) + 2–4 active projects mapped to it
  (`.pc-proj`: name, RAG-style health pip `.rag-pip.green`/`.yellow`, one sentence of *why* it counts
  toward this pillar specifically — not a status recap).
- **Pillar 3 empty-state pattern** (`.pillar-card.thin`, dashed top border) — when no project is being
  built *as* the Portal (the common case pre-launch): don't just say "nothing here." Use `.pc-empty`
  for the honest one-liner, then `.pc-indirect` to list what's **directly transferable once it
  externalizes** (governance/auth patterns, reporting/feedback loops, architecture-alignment work,
  content/playbook workstreams already in flight elsewhere in the portfolio). This is the load-bearing
  honesty move: the Portal's "0 direct initiatives" reads as sequencing, not neglect, because its
  internal analog is visibly being built first.

**Primary-pillar assignment is Code's editorial judgment each week, not a dedicated Notion field.**
Draw candidates from each project's existing `Pillars` chip tags in the Projects DB (the broader
6-tag taxonomy already rendered on Briefing project cards — Governance & Standards, Enablement &
Education, Performance Intelligence Platform, etc. — is NOT the same set as the 3 official mandate
pillars), then pick ONE clearest-home pillar per project for this section even if a project spans two
(note it once, in its clearest home, rather than duplicating a card across pillars). Same honesty/
3-state badge and language rules below apply to this section's copy.

## Honesty / 3-state badge system (v3 — MANDATORY)

Public site to a VP/CTO — **never overstate**. Tag every capability: **LIVE** (running now, teal) ·
**BUILT IN-REPO** (code-complete/proven, not yet hosted, sky) · **DESIGNED · NEXT** (designed, not
built, dashed). The Salesforce connector is **"live in ALPHA"** (released for alpha testing — NOT GA;
never "live in production"). Reporting hosted distribution + the feedback auto-alert are DESIGNED·NEXT;
the report engine + feedback capture/store/pull are BUILT IN-REPO. **No real person names** (HMAC
pseudonyms / counts only) — role titles for owners ("Program lead", "NetSuite admins", "IT"); the two
addressed sponsors, **Carly and Christian, are the sanctioned exception** (they are the audience).
**Claim calibration:** a 16-case adversarial suite is "demonstrated"/"held 16/16"/"boundary-tested" —
never "proven"/"secure". The HTML is grep-audited for these rules before publish. Showcase patterns
(reusable, proven in `fourthos/2026-06-24/`): the interactive 3-view governed-report toggle and the
inheritance diagram ("build the mold once; every connector inherits the governance"). Any demo data
inside the toggle must be internally consistent across all three views and carry an explicit
provenance label (e.g. "validation-window snapshot").

## Clarity Contract [MANDATORY — the #1 language rule, strengthened 2026-07-23]

**This is the top writing rule; the Language rules below serve it.** The whole job of this report is
to compress a week of dense, technical work into bite-sized units two busy leaders understand in ONE
pass. Clarity beats completeness: cut a true-but-opaque detail rather than ship a sentence they cannot
decode.

**Know the readers.** Carly (VP) and Christian (CTO) are the audience, and they are **NOT inside the
projects.** A term that is obvious to the builder means nothing to them. Every sentence is read cold by
a smart non-technical leader. If a sentence needs project context to parse, it fails — rewrite it.

**The Change → Benefit rule (applies to EVERY unit: progress items, "what changed", each portfolio card's
current focus / latest update / next milestone, every outcome, every risk, every sponsor action).**
Every unit answers two questions in plain words:
1. **What concretely changed** this week — the observable move. Banned openers: "worked on", "progressed",
   "continued", "made progress on", "focused on". Those describe activity, not change.
2. **The benefit, and to whom** — what that change now makes possible, for a *named beneficiary*: the
   company, a specific team (CS, RevOps, GTM), end users, a customer, or **the sponsors' own decision**.
   Force the link with "so that" / "which means" / "so".

> If you cannot name a benefit and a beneficiary, it is activity, not progress. Dig for the real outcome,
> or cut the item. "Benefits the business" is too weak — name who, and what they can now do.

**Write it in this shape:**
- **Outcome first, mechanism second** (and only if the mechanism earns its place).
  ✅ "Answers are now trustworthy across teams, because the connector checks each business term against a
  verified dictionary before using it." ❌ the reverse order.
- **One idea per sentence.** Short sentences win. If a sentence can be halved, halve it.
- **Define a technical term on first use or replace it** (jargon table below) — prefer the plain phrase.
- **No internal shorthand, repo names, ticket/rev numbers, or tool names** in Tiers 1–2.

**Method — the So-What Ladder (now MANDATORY here; it is no longer a "v4-planned" idea).** Climb every
technical item four rungs: **Raw** (version / test count / bug — never shown) → **Capability** (plain verb:
what it can now do) → **Value** (pick ONE axis: Trust · Usefulness · Risk retired · Readiness · Speed) →
**Sponsor sentence** (≤25 words, one evidence anchor, the honesty badge, names the beneficiary). Carly
reads the Sponsor sentence; Christian reads Capability + one soundness number.

**Calibration — before → after. This IS the bar; match it every week.**

| ❌ Opaque / activity-only (builder voice) | ✅ Change → Benefit, plain (sponsor voice) |
|---|---|
| "Semantic layer Phase A code-complete; 1,144 tests green; picklist visibility + governed dictionary shipped." | "The connector now checks each business term against a verified dictionary before it answers, so a question like 'top EMEA deals by value' returns the same correct number for any team instead of a confident guess." |
| "Reframed model-routing into a governed agent-delivery platform with reusable Agent Packs." | "We now have a plan to assemble automations from reusable, pre-governed building blocks, which means future AI tools ship faster and are all controlled the same way, instead of being hand-built one at a time." |
| "NetSuite Spike A0 unblocked, no admin dependency." | "We can decide NetSuite's technical approach this week without waiting on admin access — removing a dependency that would otherwise stall the third connector." |
| "Architecture review still unscheduled (3rd week)." | "The architecture review with Christian still is not booked (third week). Until it happens, three connectors keep building on a design he has not signed off, so a late correction gets more expensive each week. This is the one thing we need from you." |

**Pre-publish clarity check (run alongside the banned-word grep, before staging):**
1. Read each Tier-1 sentence as Carly. Any term she would have to ask about? Define it, replace it, or cut it.
2. Does every progress / outcome / focus item name a benefit AND a beneficiary? If not, fix or cut.
3. Is the outcome first and the mechanism second?
4. Could any sentence be halved? Halve it.

## Language rules (MANDATORY — Dave, 2026-07-02) — the mechanics that serve the Clarity Contract above

The writing must be **intelligent and clear** — no dumbing down, and no insider shorthand. A smart
non-engineer (Carly) reads every sentence cold; a CTO (Christian) reads for soundness.
- **BANNED WORDS:** "topology" (always — say "where the reports are hosted" / "hosting setup").
- **Technical terms must be defined on first use or replaced.** Standard replacements:
  | Jargon | Write instead |
  |---|---|
  | (gated) SWA / Static Web App | "access-gated report site" (first use may add "(an Azure Static Web App)") |
  | ACA / ACA Job / rev NNNN | "on Azure" / "scheduled report job" / drop rev numbers from Tier 1 (keep ONE in the deep-dive workstream card as the traceability anchor) |
  | Entra groups | "per-audience security groups" / "access groups" |
  | OBO / token exchange | "each person signs in as themselves" / "your own Microsoft sign-in (per-user)" |
  | auth model | "sign-in model" / "sign-in approach" |
  | ADR | "architecture decision record" |
  | chassis / clone the chassis | "reuse the Salesforce build as the mold" (mold/stamp is the house metaphor) |
  | Phase-0 / spike | keep, but define once per page: "(the hands-on discovery check)" |
  | Cosmos | "the system of record" |
- Sentences carry one idea each; every technical item states its "so what" via the **Change → Benefit
  rule** and the So-What Ladder in the Clarity Contract above (both now mandatory, not v4-planned).

## Render constraints (reuse, do not rebuild)

- **Brand:** load `.claude/skills/fourth-brand-guidelines/` for copy/tone. Deep Blue `#0C4A7D`,
  Teal `#00B69F` (CTA/accent only), Poppins, `iQ` (lowercase i / uppercase Q), "Powered by iQ".
- **HTML engine:** `.claude/skills/fourth-presentation-suite/html-engine/themes/fourth-executive.html`
  (CSS-variable source of truth) + `components/midnight-components.html` (reusable blocks).
- **Deep-dive motion:** `.claude/skills/frontend-slides/` scrollytelling patterns.
- **Diagrams:** `.claude/skills/excalidraw-mcp/` — build ONCE interactively, export SVG to
  `fourthos/assets/`. The canvas server can't run headless, so the weekly task embeds the committed
  SVG and only regenerates when the architecture changes.
- Each tier is a **single self-contained HTML file** (zero external network requests), matching the
  rest of the decks repo.

---

## Publish target — `ai-enablement-decks` (read its CLAUDE.md before touching)

- Local: `C:\Users\david.hayes\Projects\ai-enablement-decks` · remote `Rev4nchist/ai-enablement-decks`
  (PUBLIC) · auto-deploys on push to `main` via `.github/workflows/pages.yml`.
- A deck = a `<slug>/index.html` folder **plus** an entry in `decks.json` (the hub renders from the
  manifest, not from static cards). **A folder without a manifest entry is live-but-unlisted** — that
  is exactly the draft/preview mechanism.
- **Dedicated hub section:** a `sponsor-updates` section sits FIRST on the hub (above all others),
  rendered newest-first with **one row visible** and the rest behind a "Show N earlier updates" toggle
  (the renderer measures `offsetTop` so "one row" stays true at any width). Section + collapse logic
  live in the repo's `index.html`; the section is declared in `decks.json` `sections[0]`.
- **Each week = its own dated card.** Promotion publishes `fourthos/<YYYY-MM-DD>/` and adds a
  `fourthos-<date>` card to `sponsor-updates` (only the newest is `featured`). Bookmark the hub
  (`https://rev4nchist.github.io/ai-enablement-decks/#sponsor-updates`); the top card is always newest.
- Layout:
  ```
  fourthos/
  ├── preview/                ← weekly staging (UNLISTED — never added to decks.json)
  │   ├── index.html          ← mini-hub (links briefing + deep-dive)
  │   ├── briefing.html       ← Tier 1 dashboard (Pulse hero + portfolio/actions/risk/outcomes)
  │   ├── deep-dive.html      ← Tier 2 teaching deep-dive (+ Concept Spotlight, inline SVG)
  │   └── card.json           ← hub-card metadata for promote.mjs (tag/title/description/meta/date)
  └── <YYYY-MM-DD>/           ← each promoted week's standalone report (the dated cards)
  ```

---

## Fail-loud guards (never publish empty/stale over good content)

1. If the Notion MCP is unreachable or returns an auth error → this IS a failure: write
   `fourthos/preview/_ERROR.md` with the reason, notify Dave "generation FAILED", print
   `fourthos-weekly: FAILED reason=notion-unreachable` and **exit 1**, and **do not** overwrite
   the stable `fourthos/`.
2. If the FourthOS Projects DB reads empty/missing → treat as failure (same as above), not as a
   valid "nothing to report".
3. `promote.mjs` validates `decks.json` parses before committing — a broken manifest blanks the whole hub.
4. Single-session only; no subagents in the headless run. Time budget ~6 min; bail with a clear
   status line if any single MCP call exceeds 60s.

---

## Notify (the internal "ready for review" ping — NOT the sponsors)

On a successful generate, notify Dave via **both**:
- **Slack DM** to Dave (`slack_send_message`) with the preview URL + a ≤5-bullet change summary.
- **Notion comment** on the cockpit's "Sponsor Update Workspace" section with the same.

End the headless run with exactly one stdout line:
`fourthos-weekly: OK preview=<url> changed=<n>` — or `fourthos-weekly: FAILED reason=<short>` (exit 1;
INCLUDES Notion unreachable / auth errors, per guard #1) — or `fourthos-weekly: SKIP reason=<short>`
(exit 0; reserved for a deliberate no-publish condition only, never an error path).

**Wrapper-side verification (since 2026-07-16):** the scheduled `.bat` does not trust this line
(or the exit code) alone. It captures the full headless output to
`~/.claude/logs/fourthos-weekly/<YYYY-MM-DD>.log`, then `scripts/fourthos-weekly/verify-run.mjs`
classifies the outcome from artifact truth — all four preview files present, committed, last
`fourthos/preview` commit dated today, no `_ERROR.md` — plus the log sentinel, and records
**OK / Warn / Skipped / Failed** (with a reason in the summary) in the Report Runs registry.
A run that prints OK but staged no fresh artifact is recorded `Failed (no-artifact)`. The wrapper
exits 1 only on Failed; OK/Warn/Skipped exit 0 (the registry row + dated log are the observability
surface for a skip, not a red Task Scheduler light).

---

## Verification (after generate / promote)

- `gh run list --repo Rev4nchist/ai-enablement-decks --limit 3` → `success`.
- Preview URL loads, brand-correct, SVG visible; hub root does NOT show a FourthOS card (correct while unlisted).
- After promote: `fourthos/<date>/` is live at its own URL; the hub's **Sponsor Updates** section
  (`https://rev4nchist.github.io/ai-enablement-decks/#sponsor-updates`) shows the new week as the top
  `featured` card with prior weeks demoted behind the collapse; `decks.json` still parses; `preview/`
  is gone. **The hub page itself is never hand-edited** — `#sponsor-updates` renders from `decks.json`
  at load, and `promote.mjs` is the ONLY thing that writes that manifest entry (generate must not, G4).
  The per-page week-switcher picks up the new week from the same manifest automatically.

## v4 — planned report enhancements (agreed with Dave, 2026-06-30)

Direction for the next iteration of the Tier-1 Briefing — synthesized from a 4-lens design
panel (decision-first, narrative-translation, velocity-metrics, novel-visual), which converged
strongly. **Extends** this pipeline; not yet built. Honesty bar and 3-state badges still apply.

**One new infra dependency:** persist a **weekly cockpit snapshot** (Projects + Decisions &
Outputs JSON) into the Tier-3 archive each run, so week-over-week diff + aging are computable.
Everything else reads existing cockpit data.

1. **Velocity — "Ship Rate" + "Trajectory."** Per project: impact-weighted count of Decisions
   & Outputs rows (High=3 / Med=2 / Low=0) over trailing 4wk (Ship Rate), a colored trend vs the
   project's OWN prior-4wk baseline (▲/▬/▼ Trajectory), and a 6-week sparkline. Count SHIPPED
   OUTPUTS, never "Latest Update" edits (anti-vanity). Honesty catch: high motion + zero High/Med
   output → a "busy, not shipping" tell. Show raw counts + a trailing Health dot beside the bar.
2. **What Moved + Stall Watch.** Top-of-briefing **diff ribbon** = this week's snapshot vs last
   week's, ordered by attention: risk-degradations → wins/milestones → status changes → ships. Its
   mirror **Stall Watch** = days-since-movement per project (max of Latest-Update / output date /
   status·health·milestone change / task done), classified: **Waiting** (blocked on a *named*
   external dep → auto-promotes to the Ask Box), **Aging** (no blocker → needs a decision),
   **Parked** (by design → muted, never counted as failure). Empty state: "All active projects
   moved this week."
3. **The Ask Box (the spine).** Literal top of the artifact: "What I need from you this week" —
   0–3 decision cards, each = the ask + why + cost-of-not-deciding + a RECOMMENDED default + a
   forcing function ("if I don't hear by Fri, I proceed with X"). Honest empty state: "Nothing
   needed — FYI read." Every sensor (stalls, spinning tells, health drops) auto-promotes into it,
   so the report becomes a decision instrument, not a status broadcast.
4. **So-What Ladder (the narrative method — solves "too technical → why it matters").** **NOTE:
   PROMOTED (2026-07-23) — the So-What Ladder + Change → Benefit rule are now MANDATORY and live in the
   "Clarity Contract" section above; they apply every week regardless of the rest of v4.** Climb
   every technical item 4 rungs: **Raw** (version/test/bug — never shown) → **Capability** (plain
   verb) → **Value** (pick ONE axis: Trust/Usefulness/Risk-retired/Readiness) → **Sponsor
   sentence** (≤25 words, one evidence anchor, honesty badge). **Carly reads rung 4; CB reads rung
   3 + a soundness number** — same ladder, different stop, so this ONE engine powers both the
   dual-audience split and the translation. Honesty rubric (all must pass): evidence-trace (no
   D&O row → no claim), jargon-zero (banlist: ACA, SOQL, revision, OBO, serializer…),
   so-what test, no-overstatement (verbs "demonstrated" not "secure"; badge = LIVE/BUILT/NEXT),
   grandparent-readable. Worked example — "W1/W2/W3+F1, rev 0000020, 16/16 boundary test" →
   Carly: *"We pressure-tested the connector's security — 16 deliberate attempts to leak one
   user's data to another, all blocked — and fixed the empty/wrong answers, so it's safer and more
   useful ahead of widening the pilot."*
5. **CB confidence chip + Decision Latency.** One CTO-lens soundness signal (e.g. "isolation
   16/16 · 1055 tests green"). **Decision Latency** = days an Ask has waited ON the sponsor
   (symmetric — holds Carly/CB accountable, not just Dave). Other honest indicators to consider:
   blocked-days ledger, weeks-in-red, proof-point countdown, first-time-right/rework.

**Build order when green-lit:** snapshot persistence → add `whatMoved[] / stallWatch[] /
velocity[] / asks[] / cbConfidence` to the Update-Package §9 data model → Tier-1 render blocks →
So-What Ladder (banlist + rubric) as a `generate` build-step over Latest-Update + D&O rows.

---

## Related
- Scheduling pattern: `scripts/scheduled-health-check.bat` + `scripts/notion-health-prompt.md`.
- Task inventory: `.claude/docs/architecture/cheatsheet.md` (`CCv3-FourthOS-Weekly`).
- Plan of record: `~/.claude/plans/i-need-to-set-piped-minsky.md`.
