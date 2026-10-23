# Claude for Sales Package — Account Planning Kit (#3), Installable Skills (#4) & SKO Course Design

## Context

Fourth's Sales Kickoff (late July 2026, ~2 weeks out) needs the two highest-leverage deliverables of the Claude for Sales Package designed and built: **#3 the Account Planning Project Kit** (a Claude.ai Project per account: instructions, context template, Salesforce recipe, worked example) and **#4 installable Claude App Skills** (account research + account planning as installed capability, not paste-text), plus the course structure that delivers them. Source review: `docs/claude-for-sales/00-SOURCE-REVIEW.md`.

Two proven in-house assets anchor the design: the **EBR Builder suite** (Project instructions + orchestrator → research → presentation skill chain, 3 human checkpoints, confidence scoring, onboarding guide) and the **fourth-playwright MCP** (`Projects\fourth-playwright-mcp`, Railway). A 7-agent workflow (3 Sonnet researchers → 3 Opus designers → Opus judge) produced the merged blueprint — *"One Account, Tiered: build it, keep it, compete with it"* — reconciled with Dave's four locked decisions, then hardened by a cross-model premortem (5 Claude findings + 8 findings, all folded in below).

## Locked decisions (Dave, 2026-07-13)

1. **SKO late July** → v1-lean scope; pilot before the event.
2. **Salesforce connector IS provisioned** in the Sales Claude Enterprise workspace → primary data path for Enterprise tier, **conditional on the early-license pilot gate below** (review#1). Session-bound; respects sharing rules — "sparse data = check your access" callout required.
3. **Account plan format: both, tiered** → living structured doc (Canvas/markdown) is the working artifact; Fourth-branded HTML deck is the optional "present to your manager" upgrade at the advanced lunch session.
4. **Reps use built-in web search only** → fourth-playwright is OUT of the rep flow (kills the CAPTCHA-storm risk class). It remains Dave's facilitator demo, the EBR/CS tool, and the Fourth Brain teaser. The `playwright-competition` skill survives as the *pattern* (curated sources, confidence tags, brief format) re-based onto built-in search.

## The design

**Organizing principle:** every rep picks one real account **from their own territory** at the door and carries it all day — Claude 101 → tiered breakout → 10-min competition. Beginners produce a research brief; Enterprise produces a full account plan. Same account, different depth.

**Two-tier package:**

| Tier | Project | Skills | Output |
|---|---|---|---|
| Beginner/SDR + Emerging-beginner | **Account Research Starter** (1-page instructions, 7-field context stub) | ONE skill: `account-research` | Research brief (C1–C5 prompt cards) |
| Enterprise + Emerging-advanced | **Account Cockpit** (full instructions: role, qualification-translation table, confidence tags, no-fabrication rule) | `account-research` + `account-planner` (compressed 3-gate orchestrator+writer) | Living account-plan doc; optional branded HTML deck (lunch session) |

**The five beginner prompt cards (laminated):**
- **C1** company snapshot · **C3** buying-signal scan · **C4** incumbent-vendor check · **C5** contact-ready cold-call brief
- **C2 buying-committee mapping** *(redesigned per review#8)* — maps roles and publicly stated leadership from the company site, press releases, and trade-press quotes with confidence tags; where public sources only yield the role (not the person), the card outputs "title to verify on LinkedIn" — LinkedIn verification is explicitly the rep's manual step, stated on the card itself. The skill never fabricates names from search snippets (hard rule + judged in the competition).

Enterprise cards map to the 5 plan phases (setup → SF pull → research → synthesize → qualification translation). Five is a hard cap.

**The Tuesday Card (tool-confusion firewall, verbatim):** Claude = "my thinking partner that researches and drafts." Fourth Encyclopedia = "my phone lookup for product facts." Fourth Brain = "coming later — Claude plugged into our internal docs."

### Session structure (revised per review#5)

**Setup happens BEFORE the breakout clock starts.** A 15-minute **Setup Block** at the end of the Claude 101 plenary (facilitator-led, IT floater present): device/browser check, workspace login + MFA, create Project, install skills, paste instructions, authenticate Salesforce (Enterprise tier). Success check on screen: "your account's opportunities appear." Reps who fail any step get flagged to the IT floater and use the fallback pack in the breakout — nobody debugs auth during exercise time.

**Enterprise breakout run-of-show (60 min, post-setup):**
- 0:00–0:08 — fill 6-field account-context template (only typing)
- 0:08–0:18 — Prompt 2: Salesforce pull → account snapshot (checkpoint: does this match what you know?)
- 0:18–0:30 — Prompt 3: web research via `account-research` (built-in search)
- 0:30–0:42 — Prompt 4: synthesize → account-plan draft (checkpoint: reshape before polishing)
- 0:42–0:52 — Prompt 5: qualification translation (the quality bar)
- 0:52–1:00 — save + Canvas walkthrough; "this Project is yours, it's on your phone tonight, you compete with it in 20 minutes."

Dave floats all rooms during the 0:08–0:42 failure-dense window.

### Competition (revised per review#3, #4)

- **Fresh arena, not the rep's account Project** — a blank "Competition Arena" Project (skills installed, starter instructions, NO account context) is created by every rep during a 5-minute pre-competition setup window. The 10-minute timer starts when the surprise account is revealed. No context bleed from their real account; setup time never counts against the clock.
- **Surprise account is pre-researched** — facilitators hold a pre-built **answer-key packet** (researched 1–2 days prior via the EBR research stack) for 2–3 candidate surprise accounts. Judges verify claims against the key, not the rep's own citations.
- **Quality gate (judgeable):** all sections present · confidence tags used · every named person traceable to the answer key or a clickable source (judges spot-check 2 random claims per finalist) · fastest **valid** brief wins. Passing = the certification moment.

**Reinforcement:** day-30 manager check ("built one real brief?"), day-60 refresher on least-used card, day-90 competition re-run.

### Data handling (new section per review#2)

- Reps work **only accounts from their own territory** — Salesforce sharing rules are the access boundary; the kit never asks anyone to widen visibility.
- **No bulk contact exports** in any prompt card or skill; contact data stays inside the rep's own Project.
- **Screen-share rule:** facilitators project only the demo/fallback account (anonymized), never a rep's live Project.
- **Surprise competition accounts are public-web-researchable prospects or synthetic composites** — never another rep's live pipeline account.
- **Post-event:** Projects are rep-owned inside the Fourth-managed Enterprise workspace (org retention controls apply); the facilitator cheat sheet states "your account Project is a working tool — treat its contents like Salesforce data." Runbook gets a one-paragraph data-handling note reviewed by Sarah before SKO.

**Cut (explicit):** PPTX engine for v1; LinkedIn scraping (manual human step, stated in-skill AND on card C2); orchestrator + checkpoints for beginners; a separate Processor project; any 6th prompt; fourth-playwright in rep hands.

## Implementation — author the package in `docs/claude-for-sales/`

All artifacts are markdown drafts we hone together, structured for direct paste/upload into Claude.ai. Model wording on the EBR files (clone → swap CS vocabulary for sales).

```
docs/claude-for-sales/
├── 00-SOURCE-REVIEW.md                      (exists)
├── 01-PACKAGE-DESIGN.md                     — this blueprint as the working design doc
├── account-planning-kit/                    (#3)
│   ├── COCKPIT-PROJECT-INSTRUCTIONS.md      — Enterprise tier
│   ├── STARTER-PROJECT-INSTRUCTIONS.md      — beginner tier (~1 page)
│   ├── account-context-template.md          — 6-field (Ent) + 7-field (beginner)
│   ├── salesforce-connector-runbook.md      — provisioning, rep auth step, sparse-data callout, data-handling note
│   └── example-plan.md                      — finished anonymized worked example = the fallback pack + acceptance fixture
├── skills/                                  (#4)
│   ├── account-research/SKILL.md            — ALL tiers; playwright-competition pattern on built-in search; C2 no-fabrication + LinkedIn-manual rules baked in
│   └── account-planner/SKILL.md             — Enterprise; compressed 3-gate orchestrator + doc-writer
├── course/
│   ├── run-of-show.md                       — plenary + Setup Block + per-room scripts
│   ├── prompt-cards.md                      — 5+5 cards, print-ready (C2 redesigned wording)
│   ├── facilitator-cheat-sheet.md           — firewall, degraded-mode table, data-handling rules, "when a rep asks X say Y", quality-veto gate
│   └── competition.md                       — Arena mechanics, answer-key packet spec, judge rubric
└── reinforcement/30-60-90.md
```

**Build order (revised per review#1, #6, #7 + Claude findings — gates first, fixture early):**

1. **Day-1 platform gate (before writing anything):** verify in Fourth's Sales Claude Enterprise workspace — (a) App Skills can be published + rep-installed (or determine admin-push path), (b) built-in web search is enabled, (c) Salesforce connector object scope (opportunities/contacts/activities readable). **Ask Sarah/Jay for 5 named pilot licenses NOW** — resolves the licenses-at-SKO contradiction; if pilot licenses are refused, Salesforce demotes to facilitator-demo + hand-filled context becomes the primary Enterprise path (decide by day 3). Also: sync with Sarah on run-of-show ownership + survey results.
2. `account-research/SKILL.md` — the workhorse; everything depends on its output shape.
3. **`example-plan.md` (fallback pack) immediately after** — becomes the acceptance fixture every downstream artifact is validated against (cards, rubric, cheat sheet all must "pass" against it before being finalized).
4. Kit: both PROJECT-INSTRUCTIONS + context templates + SF runbook (incl. data-handling note).
5. `account-planner/SKILL.md` (Enterprise chain).
6. Course materials: run-of-show (with Setup Block), prompt cards, cheat sheet, competition + answer-key packet spec — each validated against the fixture from step 3.
7. **Pilot ladder:** (a) Dave solo end-to-end in a real Project; (b) 5 pilot reps run the full flow **simultaneously on office wifi** — validates auth AND concurrency/throttling in one session (if throttling appears, room plan staggers SF pulls by table); (c) facilitator dry-run of cheat sheet + degraded modes.

The advanced-lunch HTML deck upgrade is deliberately after items 1–7 — built only if runway allows.

## Risk register (pre-mortem, cross-model)

| # | Source | Risk | Mitigation (folded into plan) |
|---|---|---|---|
| 1 | Claude | Skill-install mechanics unverified until late | Moved to Day-1 platform gate (build step 1) |
| 2 | Claude | Built-in web search may be admin-disabled | Day-1 platform gate |
| 3 | Claude | Sarah owns training; survey not in | Step-1 sync; run-of-show is a shared doc with Sarah |
| 4 | Claude | Schedule compression | Gates-first build order; lunch-deck deferred; fixture-driven validation shortens step 6 |
| 5 | | Licenses-at-SKO contradicts pre-SKO dry-run | 5 named pilot licenses requested day 1; fallback = SF demoted to demo-only (decision by day 3) |
| 6 | | No data-handling boundary for real CRM data in a training room | New Data Handling section: own-territory rule, no bulk exports, screen-share rule, synthetic competition accounts, retention note |
| 7 | | Competition contaminated by per-account Project context | Competition Arena Project (blank, pre-created in setup window); timer starts at account reveal |
| 8 | | "Zero fabricated names" unjudgeable live | Pre-built answer-key packet for surprise accounts; judges spot-check 2 claims per finalist |
| 9 | | First 5 minutes bundles install+auth+MFA | Setup Block moved out of the breakout entirely (15 min, plenary-end, IT floater) |
| 10 | | 5-rep dry-run doesn't test concurrency | Pilot step (b): 5 reps simultaneous on room wifi; stagger-by-table plan if throttled |
| 11 | | Fallback pack built after materials that depend on it | Example plan moved to build step 3; is the acceptance fixture for all course materials |
| 12 | | C2 decision-maker card has no compliant source path | C2 redesigned: buying-committee mapping from public sources, role-only output where names aren't public, LinkedIn = manual rep step stated on the card |

### Pre-Mortem Run
- Date: 2026-07-13 · Mode: quick (plan) · Cross-model pass: **** (gpt-5.5 @ xhigh)
- Findings: Claude-only 5· agreed 0 → lift = 8

## Verification

- **Day-1 platform gate is the first verification**, not the last: skills installable, web search on, SF scope confirmed, pilot licenses secured.
- **Live pilot ladder (build step 7):** solo end-to-end → 5 simultaneous pilot reps (auth + concurrency) → facilitator dry-run.
- **Fixture validation:** every prompt card and the competition rubric demonstrably produce/judge correct output against `example-plan.md` before finalization.
- **Quality-gate check:** run the competition rubric against pilot outputs — all sections, confidence tags, all names traceable to sources.

## Open items (not blocking)

- Emerging-advanced tier placement: full planner skill vs research + lighter plan stub — decide after pilot.
- Competition judging artifact: the doc's summary section on-screen (1-slide snapshot only if the deck upgrade ships).
- Fourth Brain teaser: 60-second Dave-driven fourth-playwright demo — script in run-of-show.
