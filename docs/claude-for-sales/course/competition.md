# SKO Competition — The Certification Moment

*Claude for Sales · Account Research Starter + Account Cockpit · SKO late July 2026*

The competition is the day's payoff: every rep, on a **surprise account they've never seen**, produces a valid research brief against the clock. Passing the quality gate — not raw speed — is the **certification moment**. This doc is the print-ready operating spec: arena mechanics, the facilitator answer-key packet, and the scoreable judge rubric.

**The one-line contract:** *fastest **valid** brief wins.* A shallow-but-fast brief cannot win — the minimum-quality veto (§3) kills it before speed is even considered.

**The deliverable being judged** is the **5-card research brief** (C1–C5) from the `account-research` skill — the universal certification artifact both tiers can produce in 10 minutes. (Enterprise reps who worked the Cockpit all day still compete on the brief; the 8-section plan is a 60-minute artifact, not a 10-minute one.) The card names are fixed and load-bearing:

- **C1 Company Snapshot** · **C2 Buying-Committee Map** · **C3 Buying-Signal Scan** · **C4 Incumbent-Vendor Check** · **C5 Contact-Ready Cold-Call Brief**
- C5's four fixed sub-fields: **Opener / First call target / Sharpest signal / Fourth angle.**

---

## 1. Arena Mechanics

### 1.1 The fresh blank "Competition Arena" Project

Reps do **NOT** compete inside their own account Project. Context bleed from a rep's real, all-day account would poison a surprise-account brief (the model would pattern-match to the wrong company) and would risk a rep's live pipeline data landing in a judged, screen-shared artifact. Both are unacceptable.

Instead, every rep creates a **brand-new, blank Competition Arena Project**:

- **Skills installed:** `account-research` (all tiers). Enterprise reps may also have `account-planner` installed — it simply won't be invoked for a 10-minute brief.
- **Starter instructions pasted** (the Account Research Starter 1-page instructions).
- **NO account context.** No 7-field context stub, no prior brief, no Salesforce authentication for any specific account. The Project is a clean room.
- **No Salesforce connection is required** for the competition — the surprise account is a public-web prospect or synthetic composite, researched with **built-in web search only**. (fourth-playwright is OUT of the rep flow, here as everywhere.)

### 1.2 The 5-minute pre-competition setup window (never on the clock)

Before any timer starts, facilitators run a **5-minute setup window**:

1. Rep creates the new blank Competition Arena Project.
2. Rep confirms `account-research` is installed and the starter instructions are pasted.
3. On-screen success check: **"Fresh Project open, skill installed, no account loaded — ready."**
4. Any rep who can't get a clean Project is flagged to the IT floater and moved to the fallback (§1.5) — **before** the clock, never during.

**Setup time never counts against the competition clock.** This is the -hardened fix: bundling install/auth into the timed window penalized the reps with the slowest laptops, not the weakest research.

### 1.3 The 10-minute timer starts at the surprise-account REVEAL

- The clock starts **only** when the surprise account is revealed to the room — a single announced account name (plus a one-line "they're a [segment] operator" framing, nothing more).
- **10 minutes**, hard stop. Reps research and produce the C1–C5 brief inside the Arena Project using built-in web search.
- At 10:00, hands off keyboards. Reps submit the brief (paste into the submission channel / hand the laptop to a judge per the room's method).

### 1.4 No context bleed — the guarantees

| Risk | Guarantee |
|------|-----------|
| Rep's real account contaminates the brief | Fresh blank Project, zero prior context loaded |
| Rep's live pipeline data gets screen-shared/judged | Surprise account is public-web or synthetic — never a rep's live account (§2.4) |
| Slow-laptop reps penalized on the clock | Setup is a separate 5-min window, off the clock |
| Pre-researching the surprise account | Account name is withheld until the reveal; the clock and the reveal are the same instant |

### 1.5 Fallback (a rep's Arena won't work)

A rep who can't get a clean Arena Project running in the setup window does **not** debug during the competition. They either (a) pair-observe a working rep as a non-scored participant, or (b) study `example-plan.md` PART A (the Harbor & Vine research brief) as the worked example. Certification for that rep is deferred to the day-90 competition re-run. Nobody debugs auth or installs during exercise time.

---

## 2. The Answer-Key Packet Spec

The hard problem flagged: **"zero fabricated names" is unjudgeable live** — a judge can't verify a rep's citation for a surprise account in real time. The fix: facilitators pre-research the surprise accounts and judge against a **pre-built answer-key packet**, not against the rep's own citations.

### 2.1 Who builds it, when, how

- **Built by:** facilitators (Dave + designated facilitator), using the **EBR research stack** (the fourth-playwright / EBR-Builder research tooling — the facilitator-side tool, which reps never touch).
- **When:** **1–2 days prior** to SKO. Not day-of — the packet must be reviewed and stable before the reveal.
- **For:** **2–3 candidate surprise accounts** (so the revealed account can be chosen day-of, and a backup exists if one account's public footprint turns out too thin).

### 2.2 What the packet contains (one packet per candidate account)

Each candidate account's packet is the **ground truth** judges score against:

| Packet section | Contents | Judge use |
|----------------|----------|-----------|
| **Verified company facts** | What they do, segment, approx unit count, geography, ownership, recent headline — each with the facilitator's clickable source URL and confidence tag | Score C1; verify a rep's C1 claims are real |
| **Buying-committee roles + public names** | The committee roles (COO/VP Ops, CFO, VP People/HR, CIO/IT, Field Ops) AND any publicly named leader with the clickable source. **Roles with no public name are explicitly marked "role only — not public"** | Score C2; verify any name a rep produces traces to a real source, or is correctly role-only |
| **Buying signals** | Dated triggers (expansion, funding, PE event, leadership change, ops/HR/workforce job postings) with sources | Score C3 |
| **Incumbent** | Suspected workforce/ops vendor per the C4 discipline — with the source and its confidence. **If none is public, marked "incumbent not found in public sources — verify manually"** | Score C4; a rep who *asserts* an unconfirmable incumbent as fact FAILS the no-fabrication check |
| **The traceable-claims list** | The explicit list of every claim in the packet a judge can verify against a clickable source — the "these are checkable, everything else is honestly a gap" reference | The spot-check (§3.3) draws random claims from here |

### 2.3 The traceable-claims list (the judging spine)

This is the packet's most important artifact. It is the **enumerated set of verifiable facts** for the account: for each, the exact fact, the clickable source URL, and the correct confidence tag. It also explicitly lists the **known public gaps** — the facts that genuinely aren't public (e.g., "CFO name: not public — correct rep answer is role-only or 'not found in public sources — verify manually'").

A rep is scored against this list, not against their own citations. A rep who invents a CFO name the list marks as "not public" has **fabricated** — an automatic quality-veto fail (§3.2), regardless of speed.

### 2.4 Account-selection rules (hard)

- **Surprise accounts are public-web-researchable prospects OR synthetic composites** (a Harbor & Vine–style invented operator with a pre-built public-style footprint).
- **NEVER a rep's live pipeline account.** Not any rep's, not from any territory. This is a data-handling boundary, not a preference.
- Public-web candidates must have **enough public footprint** to make a fair 10-minute brief possible — the packet build IS the feasibility test. If a candidate's footprint is too thin, it's cut and a synthetic composite or a richer account replaces it.
- Segment should be hospitality/restaurant (the reps' actual vertical) so the brief exercises the real muscle.

---

## 3. The Judge Rubric — a Scoreable Checklist

**Judging order is fixed and non-negotiable:** (1) minimum-quality veto → (2) validity checklist → (3) speed tie-break. Speed is evaluated **last and only among valid briefs.** This is what prevents a shallow-but-fast win.

### 3.1 Step 1 — Minimum-quality veto (pass/fail gate, checked FIRST)

A brief that trips **any** veto is disqualified before validity or speed is scored. No exceptions for a fast finish.

```
MINIMUM-QUALITY VETO — any single FAIL disqualifies the brief
[ ] No fabrication. No invented name, title, budget, headcount, or vendor.
    Any claim contradicted by the answer-key "not public" markings = FAIL.
[ ] Every named person is traceable — to the answer key OR a clickable source
    in the brief — OR is correctly output as role-only
    "title to verify on LinkedIn (rep's manual step)".
[ ] Unknowns are honestly flagged with the verbatim string
    "not found in public sources — verify manually" — not padded, not guessed.
```

If any box is FAIL → **disqualified.** Move to the next finalist.

### 3.2 Step 2 — Validity checklist (all must pass to be a "valid brief")

```
VALIDITY CHECKLIST — all four must PASS
[ ] All sections present — C1, C2, C3, C4, C5 all produced.
    C5 carries its four sub-fields: Opener / First call target / Sharpest signal / Fourth angle.
[ ] Confidence tags used — every factual claim carries exactly one of
    [VERIFIED] / [REPORTED] / [INFERRED].
[ ] Every named person traceable — spot-check passes (see 3.3).
[ ] Sales vocabulary — prospect / buying committee / buying signal / incumbent
    (not "customer", not "renewal").
```

All four PASS → the brief is **VALID** and eligible to win. Any FAIL → not valid; not eligible (but not "fabricated" unless Step 1 also tripped).

### 3.3 The spot-check procedure (how "traceable" is judged live)

For each finalist's valid brief, judges **spot-check 2 random claims**:

1. Pick 2 claims at random from the brief (favor named people and specific facts).
2. Cross-check each against the **answer-key traceable-claims list**.
3. A claim passes if: it matches a verified packet fact with a source, **OR** it's correctly tagged/flagged (role-only, or "not found in public sources — verify manually").
4. A claim that asserts a fact the packet marks "not public," or names a person the packet has no source for → **fabrication → Step-1 veto fail.**

Two random claims per finalist keeps judging fast and consistent — judges verify against the key, never against the rep's own citations.

### 3.4 Step 3 — Speed tie-break (among VALID briefs only)

Only after a brief clears the veto AND the validity checklist does its **submission time** matter. Among all valid briefs, the **earliest submission wins**. A valid brief submitted at 6:00 beats a valid brief submitted at 9:00; an invalid brief submitted at 4:00 beats neither.

### 3.5 Certification moment

**Every rep who produces a VALID brief is certified** — passing the quality gate is the certification, independent of placement. The winner (fastest valid brief) is recognized, but the room's goal is *maximize the count of certified reps*, not crown one winner. Facilitators announce: **"Producing a brief that passes the gate — every section, every claim tagged, every gap honestly flagged — is the certification. That's the skill you take back to your territory."**

### 3.6 The full scorecard (one per finalist, print-ready)

```
COMPETITION SCORECARD — Rep: __________  Account: __________  Submitted at: __:__

STEP 1 — MINIMUM-QUALITY VETO (any FAIL = disqualified)
[ ] No fabrication (checked vs answer-key "not public" markings)
[ ] Every named person traceable OR correct role-only "...(rep's manual step)"
[ ] Unknowns flagged verbatim "not found in public sources — verify manually"
        VETO RESULT:  ( ) PASS   ( ) DISQUALIFIED

STEP 2 — VALIDITY (all four must PASS)
[ ] C1–C5 all present (C5 has Opener / First call target / Sharpest signal / Fourth angle)
[ ] Confidence tags on every claim ([VERIFIED]/[REPORTED]/[INFERRED])
[ ] Spot-check: 2 random claims traced to answer key ...... claim1 (P/F)  claim2 (P/F)
[ ] Sales vocabulary (prospect / buying committee / incumbent — not customer/renewal)
        VALIDITY RESULT:  ( ) VALID   ( ) NOT VALID

STEP 3 — SPEED (valid briefs only)
        Submission time: __:__     Rank among valid briefs: ____

CERTIFIED:  ( ) YES (valid brief)   ( ) NO
```

---

## 4. Facilitator Timeline (room-level)

| Phase | Duration | What happens |
|-------|----------|--------------|
| Pre-competition setup | 5 min | Every rep creates the blank Competition Arena Project; skill-installed check; IT floater handles failures |
| **Surprise-account REVEAL** | 0:00 | Account name + one-line segment framing announced; **clock starts** |
| Timed research | 10 min | Reps produce C1–C5 in the Arena Project via built-in web search; hard stop at 10:00 |
| Submission | — | Briefs submitted at 10:00; hands off keyboards |
| Judging | ~parallel | Judges run each finalist scorecard: veto → validity → spot-check → speed; verify against the answer-key packet |
| Certification | — | All valid-brief reps certified; fastest valid brief recognized |

Dave holds the answer-key packet(s); facilitators judge against the key, not the reps' citations.

---

## 5. Guardrails Carried Into the Arena (reminders)

- **Data handling:** surprise accounts are public-web or synthetic — **never a rep's live pipeline account**; no bulk contact exports in any brief; screen-share only the anonymized demo/answer-key account, never a rep's live Project.
- **LinkedIn = manual:** the skill never scrapes it; a rep's brief correctly outputs role-only names as **"title to verify on LinkedIn (rep's manual step)"** — and that is a *pass*, not a gap.
- **Research tool:** built-in web search only. fourth-playwright is the facilitator's packet-building tool, never in the rep's Arena.
- **The Tuesday Card firewall still applies:** Claude = "my thinking partner that researches and drafts." A rep reaching for a Fourth product fact mid-brief is pointed to the Encyclopedia, not scored down — but product facts don't belong in the surprise-account brief anyway.

---

*Validate against `example-plan.md` PART A (Harbor & Vine research brief) — a rep's competition output should look like that brief. If it doesn't, it isn't a valid, certifiable brief.*
