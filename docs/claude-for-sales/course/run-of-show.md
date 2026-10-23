# SKO Run-of-Show — Claude for Sales

> **Print-ready facilitator timeline.** This is the shared master schedule for the Claude for Sales
> block at Fourth's Sales Kickoff (late July 2026). Timing is authoritative from
> `01-PACKAGE-DESIGN.md` §Session structure — do not re-invent it.
>
> **Ownership:** This run-of-show is a **shared doc** (Retired #3 / risk-register #3). **Sarah owns
> training delivery** — the sections marked **[SARAH OWNS]** are hers to run and revise; Dave owns
> the platform, the Fourth Brain teaser, the floating-support role, and the competition mechanics.
> Sarah reviews the full doc before SKO.
>
> **Roles at a glance:**
> - **Dave** — Claude 101 plenary lead, 60-sec Fourth Brain teaser, **floats all rooms 0:08–0:42**
>   (the failure-dense window), competition MC + head judge.
> - **Sarah** — training-delivery owner; leads the **Emerging** room; co-owns the Setup Block.
> - **Megan** — leads the **Beginner/SDR** room.
> - **Fernando** — floats Beginner/SDR + Emerging rooms alongside Sarah/Megan.
> - **IT floater** — present for the entire Setup Block; owns auth/MFA/skill-install failures; hands
>   flagged reps the fallback pack.
>
> **The one rule that governs the whole day:** every rep picks **one real account from their own
> territory** at the door and carries it Claude 101 → breakout → competition-warmup. Same account,
> deeper each hour. (The competition itself uses a *fresh surprise account* — see Part 5.)

---

## Day-at-a-glance timeline

| Slot | Duration | What | Lead | Room(s) |
|------|----------|------|------|---------|
| **1** | 45 min | Claude 101 plenary **+ 60-sec Fourth Brain teaser** | Dave | Plenary (all) |
| **2** | 15 min | **Setup Block** (login → Project → skills → Salesforce) | Facilitators + IT floater | Plenary (all) |
| — | — | *Break / room transition* | — | — |
| **3** | 60 min | **Tiered breakout** run-of-show | Per room (see below) | Enterprise · Beginner/SDR · Emerging |
| **4** | 5 min | **Competition Arena setup window** (blank Project) | Facilitators | All rooms |
| **5** | ~20 min | **The competition** (10-min timed brief + judging) | Dave (MC/judge) | Competition floor |
| **6** | 10 min | **Close** — certification, Tuesday Card, 30/60/90 | Dave + Sarah | Plenary (all) |

Total ≈ 2h 45m plus one transition break. Enterprise, Beginner/SDR, and Emerging run their 60-min
breakout **in parallel** in separate rooms after a shared plenary + Setup Block.

---

## PART 1 — Claude 101 Plenary (45 min) · Dave leads

**Goal:** everyone understands what Claude is (and isn't), and has their real territory account in hand.

| Time | Segment | Facilitator action |
|------|---------|--------------------|
| 0:00–0:05 | Welcome + the day's arc | "You'll each pick ONE real account from your own territory right now and carry it all day — research it, plan it, then compete with it." Reps write their account on their card. |
| 0:05–0:20 | What Claude is — the **Tuesday Card firewall** | Teach the three-tool split **verbatim** (below). This is the tool-confusion firewall; repeat it until it sticks. |
| 0:20–0:38 | Live demo — Dave researches a demo account | Screen-share **the anonymized demo/fallback account ONLY** (Harbor & Vine) — never a rep's live Project (data-handling rule). Show `account-research` producing a 5-card brief; point out confidence tags + "verify manually." |
| 0:38–0:44 | The no-fabrication promise | "Claude will say **'not found in public sources — verify manually'** before it invents a name. That honesty is what the competition scores." |
| 0:44–0:45 | Handoff to the Setup Block | "Before you touch your account, we all get set up together — next 15 minutes, IT is in the room." |

**The Tuesday Card (say verbatim, put on screen):**
- **Claude** = "my thinking partner that researches and drafts."
- **Fourth Encyclopedia** = "my phone lookup for product facts."
- **Fourth Brain** = "coming later — Claude plugged into our internal docs."

### The 60-second Fourth Brain teaser (Dave-driven, inside 0:20–0:38 demo)
A **60-second** aside using **fourth-playwright** (Dave's facilitator tool — **NOT in reps' hands**):
> "Watch — this is *me*, on the facilitator rig, letting Claude actually drive a browser to pull
> live curated hospitality sources. You won't do this today; your Claude uses built-in web search.
> But this is the shape of **Fourth Brain** — Claude plugged into *our* internal docs and tools.
> That's the 'coming later' on your Tuesday Card. Today you get the thinking partner; Brain is next."

Then close the browser and return to the built-in-search flow. The teaser plants Fourth Brain; it
never suggests reps should scrape or use Playwright themselves.

---

## PART 2 — The Setup Block (15 min) · Facilitator-led, IT floater present

> **[SARAH CO-OWNS with Dave]** — runs at the **end of the plenary, BEFORE any breakout clock**
> (Retired #5 / #9). Nobody debugs auth during exercise time. Same script in every room-to-be.

**Purpose:** get every rep from zero to "your account's opportunities appear" — login, MFA, Project,
skills, instructions, Salesforce — with IT standing by to catch failures.

| Time | Step | On-screen success check | Failure path |
|------|------|-------------------------|--------------|
| 0:00–0:03 | Device + browser check; workspace **login + MFA** | Rep sees the Fourth-managed Enterprise workspace home | MFA/login fail → flag IT floater immediately |
| 0:03–0:06 | **Create the Project** (Enterprise: "Account Cockpit"; Beginner: "Account Research Starter") | Named Project appears in sidebar | Can't create → IT floater |
| 0:06–0:09 | **Install skills** — `account-research` (all tiers); `account-planner` (Enterprise only) | Skills listed as installed on the Project | Skill won't install → IT floater; rep uses fallback pack in breakout |
| 0:09–0:11 | **Paste Project instructions** (Cockpit or Starter) + context template | Instructions saved to the Project | — |
| 0:11–0:14 | **Authenticate Salesforce connector** (Enterprise tier) | **"your account's opportunities appear"** ← the gate | Auth fail → IT floater; Salesforce demotes to fallback, rep hand-fills context |
| 0:14–0:15 | Roll-call: "thumbs up if your opportunities appeared" | Facilitator counts green; flags reds to IT | Any red → fallback pack + IT continues in parallel during breakout |

**Failed-rep path (state it out loud):** "If any step failed, you're flagged to IT — you are NOT
behind. You'll work from the **fallback pack** (`example-plan.md`, Harbor & Vine) so you see exactly
what 'good' looks like and fully participate in the breakout. IT keeps working your login on the
side." No rep sits idle; no rep debugs auth on exercise time.

**Data-handling reminder (facilitator says once):** "Your account Project is a working tool — treat
its contents like Salesforce data. Own-territory accounts only. No bulk contact exports. We only ever
screen-share the demo account, never yours."

*(Break / room transition here.)*

---

## PART 3 — Tiered Breakout (60 min, post-setup) · runs in parallel per room

Three rooms run simultaneously. **Setup is already done** — the clock below is pure exercise time.

### 3A — ENTERPRISE ROOM (60 min) · room facilitator leads · **Dave floats 0:08–0:42**

The `account-planner` skill drives this as a **compressed 3-gate phase machine**. Reps produce the
**living 8-section account plan** (gold standard = `example-plan.md` PART B). The five plan phases
(setup → SF pull → web research → synthesize → qualification translation) fold into **3 human gates**.

**Gate approval phrases** (a gate passes ONLY on an explicit one): **"looks good" · "proceed" ·
"build it" · "approved" · "go ahead" · "that's right" · "continue."** Vague enthusiasm ("nice",
"cool") is NOT approval.

| Time | Phase / Prompt | What the rep does | Gate / checkpoint |
|------|----------------|-------------------|-------------------|
| **0:00–0:08** | Fill the **6-field** account-context template | The only typing: prospect name, segment, deal stage, opportunity close date, known stakeholders, the rep's angle/hypothesis | — (Phase 0 assessment) |
| **0:08–0:18** | **Prompt 2 — Salesforce pull → account snapshot** | Skill pulls Account/Opportunity/Contact (Activity only if in scope), fuses with context into the snapshot | **GATE 1 — ACCOUNT BRIEF.** Verbatim: *"Does this match what you know? Anything to correct before I research the web?"* Catches wrong account / stale field / mis-stated stage. **Sparse SF = "check your access," not "no data."** |
| **0:18–0:30** | **Prompt 3 — web research** via `account-research` (built-in search) | Skill delegates the C1–C5 web pass; curated hospitality sources, navigation-first, no blind retry | — (research runs; rep reviews confidence tags) |
| **0:30–0:42** | **Prompt 4 — synthesize → account-plan draft** | Skill fuses SF snapshot + research brief into the 8-section skeleton with draft content | **GATE 2 — PLAN OUTLINE.** Verbatim: *"Here's the plan outline with a first draft. Reshape before I polish — reorder, cut, or add anything?"* Caps enforced out loud: Play-by-Quarter ≤4, Mutual Close Plan ≤5. |
| **0:42–0:52** | **Prompt 5 — qualification translation** (the quality bar) | Skill hardens Section 8 to the fixture bar — translation, not a field dump | **GATE 3 — QUALIFICATION-TRANSLATION QUALITY PASS** (non-negotiable). Verbatim: *"Section 8 is the bar the competition scores on — every claim tagged, every gap flagged 'verify manually.' Ready to save this as your account's living plan?"* |
| **0:52–1:00** | Save + Canvas walkthrough | Rep saves the living plan; facilitator does a Canvas tour | Close line: *"this Project is yours, it's on your phone tonight, you compete with it in 20 minutes."* |

**Dave floats 0:08–0:42** — the failure-dense window spanning Gate 1 through Gate 2 (SF auth quirks,
sparse-data confusion, cap pushback, first synthesis). This is where a rep silently stalls; Dave
circulates all three rooms here.

**Enterprise floor-call cues for the room facilitator:**
- Rep sees empty/sparse Salesforce → **"check your access, not an error"** — flag IT if it's an auth gap.
- Rep wants to keep 6 plays → the cap is a feature; trim to 4, say why ("it forces prioritization").
- Rep's Section 8 restates fields ("stage = Discovery") → send them back to Gate 3; it must read as
  qualification health ("single-threaded — the #1 risk; economic buyer not yet identified").
- Rep asks Claude for a Fourth product fact → Tuesday Card: that's the **Encyclopedia**, not this plan.

### 3B — BEGINNER / SDR ROOM (60 min) · **[MEGAN LEADS]** · Fernando + Dave float

**One skill only: `account-research`.** No orchestrator, no gates, no Salesforce. Output = the
**5-card research brief** (C1–C5). Gold standard = `example-plan.md` PART A.

| Time | Segment | What the rep does |
|------|---------|-------------------|
| 0:00–0:07 | Fill the **7-field** context stub | Prospect name + minimal known context (the only typing) |
| 0:07–0:15 | **C1 Company Snapshot** + **C2 Buying-Committee Map** | Run the skill; C2 outputs role-only where names aren't public, **"title to verify on LinkedIn (rep's manual step)"** |
| 0:15–0:25 | **C3 Buying-Signal Scan** + **C4 Incumbent-Vendor Check** | Triggers (expansion/funding/hiring) + incumbent — never assume a vendor from one mention |
| 0:25–0:35 | **C5 Contact-Ready Cold-Call Brief** | Synthesize C1–C4 into an opener + first-call target + sharpest signal + Fourth angle |
| 0:35–0:50 | **Read your Research Gaps + verify one thing** | Every unknown reads **"not found in public sources — verify manually"**; rep does one manual LinkedIn check to feel the "rep's manual step" |
| 0:50–1:00 | Share-out — 2–3 reps read their C5 opener aloud | Megan reinforces: honesty (verify-manually) is the standard the competition rewards |

**Megan's floor-call cues:** LinkedIn is **manual** — the skill never scrapes it. A blank C4 is a
*correct* answer ("verify manually"), not a failure. No bulk contact exports.

### 3C — EMERGING ROOM (60 min) · **[SARAH LEADS]** · Fernando + Dave float

Emerging reps split by readiness (placement finalized after pilot — an open item):
- **Emerging-beginner** → run the **3B Beginner/SDR** script (`account-research`, 5-card brief).
- **Emerging-advanced** → run the **3A Enterprise** 3-gate script (`account-research` +
  `account-planner`, 8-section plan).

Sarah calls the split per rep at the top of the hour and runs both tracks in the room; Fernando takes
the beginner sub-group so Sarah can gate-coach the advanced sub-group. Same verbatim gates, cues, and
data-handling rules as 3A / 3B apply unchanged.

---

## PART 4 — Competition Arena Setup Window (5 min) · Facilitators · all rooms

> **Fresh arena — NOT the rep's account Project** (Retired #7). Prevents context bleed and keeps setup
> off the competition clock.

| Time | Step |
|------|------|
| 0:00–0:03 | Every rep creates a **blank "Competition Arena" Project** — skills installed, starter instructions, **NO account context** |
| 0:03–0:05 | Facilitators confirm each Arena Project is empty + skills present; judges take positions; **no account is named yet** |

The 10-minute clock does **not** start here. Setup never counts against the timer.

---

## PART 5 — The Competition (~20 min) · Dave MCs + head-judges

> **Surprise account is pre-researched** (Retired #8). Facilitators hold a pre-built **answer-key
> packet** for 2–3 candidate accounts (researched 1–2 days prior via the EBR research stack). Surprise
> accounts are **public-web prospects or synthetic composites — NEVER another rep's live pipeline
> account** (data-handling rule).

| Time | Segment | Action |
|------|---------|--------|
| 0:00 | **The REVEAL** | Dave names the surprise account on screen. **The 10-minute timer starts NOW.** |
| 0:00–10:00 | **Timed brief** | Reps build a research brief on the surprise account in their blank Arena Project, built-in search only |
| — | **Judging (rolling)** | Judges verify claims **against the answer key, not the rep's citations**; spot-check **2 random claims per finalist** |
| ~10:00–18:00 | **Score + announce** | Apply the quality gate (below); **fastest VALID brief wins** |
| ~18:00–20:00 | **Winner walkthrough** | Winner reads their C5; Dave narrates why it passed — the certification moment |

**Quality gate (judgeable — all four required to be "valid"):**
1. **All sections present** (C1–C5).
2. **Confidence tags used** on factual claims.
3. **Every named person traceable** to the answer key or a clickable source (judges spot-check 2 random claims).
4. Unknowns honestly flagged **"not found in public sources — verify manually"** — a fabricated name
   is an automatic fail, however fast.

Fastest **valid** brief wins. Speed only counts *after* validity — this is the firewall against
"fast but fabricated."

---

## PART 6 — Close (10 min) · Dave + Sarah

| Time | Segment | Lead |
|------|---------|------|
| 0:00–0:03 | **Certification moment** — name the winner; "passing the quality gate IS the certification" | Dave |
| 0:03–0:06 | **Tuesday Card, one more time** (verbatim) — the tool-confusion firewall is what they take to the floor tomorrow | Dave |
| 0:06–0:09 | **30 / 60 / 90 reinforcement** — day-30 manager check ("built one real brief?"), day-60 refresher on least-used card, day-90 competition re-run | **[SARAH OWNS]** |
| 0:09–0:10 | **"Your Project is on your phone tonight"** — reps leave with a real, working account Project (or the fallback pack) and the plan/brief they built today | Dave + Sarah |

**Close reminders:**
- Claude = thinking partner · Encyclopedia = product facts · Brain = coming later.
- LinkedIn name-verification is **your** manual step, every time.
- Own-territory accounts only; treat the Project's contents like Salesforce data.

---

## Facilitator quick-reference card (print + hand to every room lead)

**The 3 Enterprise gates + verbatim prompts:**
1. **GATE 1 — Account Brief:** *"Does this match what you know? Anything to correct before I research the web?"*
2. **GATE 2 — Plan Outline:** *"Here's the plan outline with a first draft. Reshape before I polish — reorder, cut, or add anything?"*
3. **GATE 3 — Qualification-Translation Quality Pass:** *"Section 8 is the bar the competition scores on — every claim tagged, every gap flagged 'verify manually.' Ready to save this as your account's living plan?"*

**Approval phrases (gate passes ONLY on one):** "looks good" · "proceed" · "build it" · "approved" · "go ahead" · "that's right" · "continue." — *"nice"/"cool" is NOT approval.*

**When a rep asks X, say Y:**
| Rep asks | Facilitator says |
|----------|------------------|
| "Salesforce shows almost nothing" | "Check your access — sparse data isn't an error. If it's an auth gap, flag IT." |
| "Can Claude get me the CFO's name?" | "Only if a public source names them. Otherwise it says 'verify manually' — LinkedIn is your manual step." |
| "Can I keep 6 plays?" | "No — cap is 4. The cap forces prioritization; trim the weakest." |
| "What does Fourth's forecasting module do?" | "That's the **Encyclopedia**, not Claude. Tuesday Card." |
| "My skill won't install / login failed" | "You're flagged to IT — use the fallback pack (`example-plan.md`), you're fully in the exercise." |
| "Can I research a teammate's account?" | "Own-territory only. Salesforce sharing rules are the boundary." |

**Data-handling non-negotiables:** own-territory accounts only · no bulk contact exports · screen-share only the anonymized demo account · competition accounts are public/synthetic, never a live pipeline account.

**Caps:** Play-by-Quarter ≤4 · Mutual Close Plan ≤5 · Enterprise prompts capped at 5 · 3 human gates.
